import "server-only";
import { appUrl, CATEGORIES, CATEGORY_LABEL, getSettings, getSetting, setSetting, getTemplate, secret, type Category } from "./config";
import { q, one, lease, release } from "./db";
import { searchCategory, signerDocs, docketUrl, type ClDocket } from "./courtlistener";
import { companyFor, heuristicExtract, llmRefine } from "./extract";
import { enrich, result, leadIdOf, GOOD_EMAIL, type BcResult } from "./bettercontact";
import { render, sendMail, mailReady, type LeadVars } from "./mailer";
import { checkInbox } from "./inbox";
import { notify } from "./push";
import { logRun } from "./runs";

const MAX_NEW_PER_CATEGORY = 40;

// ---------------- Module A: discovery ----------------

export async function ingest(force = false): Promise<string> {
  const s = await getSettings();
  if (!force) {
    const last = await getSetting<string>("last_ingest_at");
    if (last && Date.now() - Date.parse(last) < s.ingest_every_min * 60_000) return "not due";
  }
  if (!(await secret("COURTLISTENER_API_KEY"))) return "no CourtListener key";
  if (!(await lease("ingest", 240))) return "already running";
  try {
    await setSetting("last_ingest_at", new Date().toISOString());
    const added: Record<Category, number> = { court: 0, tax: 0, debt: 0 };
    const skipped = { known: 0, notBusiness: 0 };
    const errors: string[] = [];
    for (const cat of CATEGORIES) {
      const conf = s.categories[cat];
      if (!conf?.on || !conf.query.trim()) continue;
      let dockets: ClDocket[] = [];
      try {
        dockets = await searchCategory(cat, conf.query, s.lookback_days);
      } catch (e) {
        errors.push(`${CATEGORY_LABEL[cat]}: ${(e as Error).message}`);
        continue;
      }
      const ids = dockets.map((d) => String(d.docket_id));
      const known = new Set(
        (await q<{ external_case_id: string }>(`select external_case_id from leads where external_case_id = any($1)`, [ids])).map((r) => r.external_case_id),
      );
      for (const d of dockets) {
        if (added[cat] >= MAX_NEW_PER_CATEGORY) break;
        if (known.has(String(d.docket_id))) {
          skipped.known++;
          continue;
        }
        known.add(String(d.docket_id));
        const company = companyFor(cat, d);
        if (!company) {
          skipped.notBusiness++;
          continue;
        }
        const docs = await signerDocs(d.docket_id);
        let x = heuristicExtract(cat, d, company, docs);
        if (!x.founderFullName || !x.debtAmount) x = await llmRefine(cat, d, docs, x);
        const ins = await q(
          `insert into leads (external_case_id, category, case_name, case_number, court_id, court_name, company_name, distress_type,
             debt_amount_text, debt_amount, creditor_summary, filing_date, insolvency_stage, founder_full_name, founder_first_name,
             founder_last_name, founder_title, founder_source, status, cl_url, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           on conflict (external_case_id) do nothing returning id`,
          [
            String(d.docket_id),
            cat,
            d.caseName,
            d.docketNumber ?? null,
            d.court_id ?? null,
            d.court ?? null,
            x.companyName,
            x.distressType,
            x.debtAmountText,
            x.debtAmount,
            x.creditorSummary,
            d.dateFiled ?? null,
            x.insolvencyStage,
            x.founderFullName,
            x.founderFirstName,
            x.founderLastName,
            x.founderTitle,
            x.founderSource,
            x.founderFullName ? "discovered" : "enrichment_failed",
            docketUrl(d),
            JSON.stringify({ party: d.party?.slice(0, 30), suitNature: d.suitNature, cause: d.cause, chapter: d.chapter }),
          ],
        );
        if (ins.length) added[cat]++;
      }
    }
    const total = added.court + added.tax + added.debt;
    const summary =
      `${total} new lead${total === 1 ? "" : "s"}` +
      (total ? ` (Court ${added.court}, Tax ${added.tax}, Debt ${added.debt})` : "") +
      (errors.length ? ` — ${errors.join("; ")}` : "");
    await logRun("ingest", errors.length === 0, summary, { added, skipped, errors });
    if (total) {
      await notify({
        title: `${total} new distressed lead${total === 1 ? "" : "s"}`,
        body: CATEGORIES.filter((c) => added[c]).map((c) => `${CATEGORY_LABEL[c]} ${added[c]}`).join(" · "),
        url: "/leads?filter=new",
        tag: "new-leads",
      });
    }
    return summary;
  } finally {
    await release("ingest");
  }
}

// ---------------- Module B: enrichment ----------------

export function webhookUrl() {
  const base = appUrl();
  if (base.startsWith("http://localhost")) return null;
  return `${base}/api/webhooks/bettercontact?token=${encodeURIComponent(process.env.WEBHOOK_SECRET ?? "")}`;
}

interface LeadRow extends LeadVars {
  [k: string]: unknown;
  status: string;
  direct_email: string | null;
  founder_last_name: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
  auto_email_sent: boolean;
  category: string;
}

export async function enrichPending(onlyId?: string): Promise<string> {
  if (!(await secret("BETTERCONTACT_API_KEY"))) return "no BetterContact key";
  const rows = await q<LeadRow>(
    `select * from leads where status = 'discovered' and founder_first_name is not null and founder_last_name is not null
       and founder_last_name <> '' and bc_job_id is null ${onlyId ? "and id = $1" : ""}
     order by created_at limit 50`,
    onlyId ? [onlyId] : [],
  );
  if (!rows.length) return "nothing to enrich";
  try {
    const id = await enrich(
      rows.map((r) => ({
        leadId: r.id,
        firstName: r.founder_first_name!,
        lastName: r.founder_last_name!,
        company: r.company_name,
        companyDomain: r.company_domain,
        linkedinUrl: r.linkedin_url,
      })),
      webhookUrl(),
    );
    await q(
      `update leads set bc_job_id = $1, status = 'enriching', enrich_started_at = now(), enrich_attempts = enrich_attempts + 1, updated_at = now()
       where id = any($2) and status = 'discovered'`,
      [id, rows.map((r) => r.id)],
    );
    await logRun("enrich", true, `Sent ${rows.length} founder${rows.length === 1 ? "" : "s"} to BetterContact`, { request_id: id });
    return `sent ${rows.length}`;
  } catch (e) {
    await logRun("enrich", false, (e as Error).message);
    return (e as Error).message;
  }
}

/** Apply a terminated BetterContact result. Safe to call any number of times for the same result. */
export async function applyEnrichment(res: BcResult, via: "webhook" | "poll"): Promise<number> {
  if (res.status !== "terminated" || !res.data) return 0;
  const s = await getSettings();
  let found = 0;
  for (const item of res.data) {
    const leadId = leadIdOf(item);
    if (!leadId) continue;
    const lead = await one<LeadRow>(`select * from leads where id = $1`, [leadId]);
    if (!lead || lead.status !== "enriching") continue;
    const emailOk = item.contact_email_address && GOOD_EMAIL.has(String(item.contact_email_address_status));
    const email = emailOk ? item.contact_email_address!.trim().toLowerCase() : null;
    const phone = item.contact_phone_number?.trim() || null;
    const li = item.contact_linkedin_profile_url || null;
    let emailSaved = email;
    if (email) {
      const taken = await one(`select id from leads where direct_email = $1 and id <> $2`, [email, leadId]);
      if (taken) emailSaved = null; // the same person is already a lead: never write to them twice
    }
    const ok = Boolean(emailSaved || phone);
    const upd = await q(
      `update leads set direct_email = $2, email_status = $3, direct_mobile = $4, linkedin_url = coalesce($5, linkedin_url),
         founder_title = coalesce(founder_title, $6), company_domain = coalesce(company_domain, $7),
         status = $8, updated_at = now()
       where id = $1 and status = 'enriching' returning id`,
      [leadId, emailSaved, item.contact_email_address_status ?? null, phone, li, item.contact_job_title ?? null, item.company_domain ?? null, ok ? "enriched" : "enrichment_failed"],
    ).catch(async (e) => {
      // A concurrent writer took the address first (unique index). Keep the phone, drop the email.
      if (String(e.code) === "23505") {
        return q(`update leads set direct_mobile = $2, status = $3, updated_at = now() where id = $1 and status = 'enriching' returning id`, [
          leadId,
          phone,
          phone ? "enriched" : "enrichment_failed",
        ]);
      }
      throw e;
    });
    if (!upd.length || !ok) continue;
    found++;
    await notify({
      title: `Contact found — ${lead.company_name}`,
      body: [lead.founder_full_name, emailSaved, phone].filter(Boolean).join(" · "),
      url: `/leads?lead=${leadId}`,
      tag: `contact-${leadId}`,
    });
    if (s.auto_send && emailSaved) await queueEmail(leadId, "initial", "auto");
  }
  await logRun(via === "webhook" ? "webhook" : "enrich", true, `BetterContact ${via}: ${found} of ${res.data.length} contact${res.data.length === 1 ? "" : "s"} found`, {
    request_id: res.id,
    credits_left: res.credits_left,
  });
  return found;
}

export async function pollEnrichment(): Promise<string> {
  if (!(await secret("BETTERCONTACT_API_KEY"))) return "no key";
  const jobs = await q<{ bc_job_id: string; started: string }>(
    `select bc_job_id, min(enrich_started_at) as started from leads
     where status = 'enriching' and bc_job_id is not null and enrich_started_at < now() - interval '3 minutes'
     group by bc_job_id limit 10`,
  );
  let done = 0;
  for (const j of jobs) {
    try {
      const r = await result(j.bc_job_id);
      if (r.status === "terminated") {
        await applyEnrichment(r, "poll");
        done++;
      } else if (r.status === "unknown" || Date.now() - Date.parse(j.started) > 6 * 3600_000) {
        await q(`update leads set status = 'enrichment_failed', updated_at = now() where bc_job_id = $1 and status = 'enriching'`, [j.bc_job_id]);
      }
    } catch (e) {
      await logRun("enrich", false, `Polling ${j.bc_job_id}: ${(e as Error).message}`);
    }
  }
  return `${done} finished`;
}

// ---------------- Module C: idempotent outreach ----------------

export type EmailKind = "initial" | "followup";

/** Lock 1 + Lock 2: verify the lead, then reserve a unique log row. Returns false when it would be a duplicate. */
export async function queueEmail(leadId: string, kind: EmailKind, origin: "auto" | "bulk" | "manual" | "auto-followup") {
  const lead = await one<LeadRow>(`select * from leads where id = $1`, [leadId]);
  if (!lead || !lead.direct_email) return { ok: false, reason: "No verified email" };
  if (lead.status === "unsubscribed") return { ok: false, reason: "Unsubscribed" };
  if (kind === "initial" && lead.auto_email_sent) return { ok: false, reason: "Already contacted" };
  if (kind === "followup" && !lead.auto_email_sent) return { ok: false, reason: "Send the new-lead email first" };
  try {
    const r = await q(
      `insert into email_log (lead_id, kind, recipient_email, status, origin) values ($1, $2, $3, 'queued', $4)
       on conflict do nothing returning id`,
      [leadId, kind, lead.direct_email.toLowerCase(), origin],
    );
    return r.length ? { ok: true } : { ok: false, reason: kind === "initial" ? "Already emailed" : "Follow-up already waiting" };
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") return { ok: false, reason: "Duplicate blocked" };
    throw e;
  }
}

export async function processQueue(max = 25): Promise<string> {
  const ready = await mailReady();
  if (!ready.ok) return "no mailbox";
  if (!(await lease("send", 280))) return "already sending";
  try {
    const s = await getSettings();
    // Sends that crashed mid-flight are never retried automatically (they may have gone out).
    await q(`update email_log set status = 'failed', error = 'Interrupted — check Sent folder before retrying' where status = 'sending' and created_at < now() - interval '15 minutes'`);
    let sent = 0;
    const t0 = Date.now();
    while (sent < max && Date.now() - t0 < 45_000) {
      // Lock 3: rolling 24-hour cap and spacing between sends.
      const st = await one<{ today: number; last: string | null }>(
        `select count(*) filter (where sent_at > now() - interval '24 hours') as today, max(sent_at) as last from email_log where status = 'sent'`,
      );
      if ((st?.today ?? 0) >= s.daily_limit) {
        if (sent === 0) await noteOnce("cap", `Daily limit of ${s.daily_limit} reached — the rest stay queued`);
        break;
      }
      if (s.send_gap_min > 0 && st?.last && Date.now() - Date.parse(st.last) < s.send_gap_min * 60_000 - 5_000) break;
      const job = await one<{ id: string; lead_id: string; kind: EmailKind; recipient_email: string }>(
        `update email_log set status = 'sending' where id = (
           select id from email_log where status = 'queued' order by created_at limit 1 for update skip locked
         ) and status = 'queued' returning id, lead_id, kind, recipient_email`,
      );
      if (!job) break;
      const lead = await one<LeadRow & { followups_sent: number }>(`select * from leads where id = $1`, [job.lead_id]);
      if (!lead || lead.status === "unsubscribed" || (job.kind === "initial" && lead.auto_email_sent)) {
        await q(`update email_log set status = 'cancelled', error = $2 where id = $1`, [job.id, !lead ? "Lead removed" : lead.status === "unsubscribed" ? "Unsubscribed" : "Already contacted"]);
        continue;
      }
      const tpl = await getTemplate(job.kind);
      const subject = render(tpl.subject, lead, s);
      const body = render(tpl.body, lead, s);
      const thread =
        job.kind === "followup"
          ? (await one<{ message_id: string }>(`select message_id from email_log where lead_id = $1 and status = 'sent' and message_id is not null order by sent_at desc limit 1`, [lead.id]))?.message_id
          : null;
      try {
        const r = await sendMail({ to: job.recipient_email, subject, body, leadId: lead.id, inReplyTo: thread });
        await q(`update email_log set status = 'sent', sent_at = now(), subject = $2, body = $3, message_id = $4 where id = $1`, [job.id, subject, body, r.messageId]);
        if (job.kind === "initial") {
          await q(
            `update leads set auto_email_sent = true, contacted_at = now(), last_email_at = now(),
               status = case when status in ('replied','unsubscribed') then status else 'contacted' end, updated_at = now() where id = $1`,
            [lead.id],
          );
        } else {
          await q(`update leads set followups_sent = followups_sent + 1, last_email_at = now(), updated_at = now() where id = $1`, [lead.id]);
        }
        sent++;
        await logRun("send", true, `${job.kind === "initial" ? "New-lead email" : "Follow-up"} sent to ${job.recipient_email} (${lead.company_name})`, { lead_id: lead.id, log_id: job.id });
      } catch (e) {
        await q(`update email_log set status = 'failed', error = $2 where id = $1`, [job.id, (e as Error).message.slice(0, 400)]);
        await logRun("send", false, `Sending to ${job.recipient_email} failed: ${(e as Error).message}`);
        break;
      }
      if (s.send_gap_min > 0) break; // one per tick when spacing is on; the next minute picks up the next one
    }
    return `${sent} sent`;
  } finally {
    await release("send");
  }
}

async function noteOnce(key: string, msg: string) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `note:${key}`;
  if ((await getSetting<string>(k)) === day) return;
  await setSetting(k, day);
  await logRun("send", true, msg);
}

/** Leads that were enriched while auto-send was off are not picked up later; auto-send covers new arrivals. */
export async function autoQueue(): Promise<number> {
  const s = await getSettings();
  let n = 0;
  if (s.auto_send) {
    const since = (await getSetting<string>("auto_send_since")) ?? new Date().toISOString();
    const rows = await q<{ id: string }>(
      `select id from leads where status = 'enriched' and direct_email is not null and auto_email_sent = false and updated_at >= $1
         and not exists (select 1 from email_log e where e.lead_id = leads.id and e.kind = 'initial')
       order by updated_at limit 50`,
      [since],
    );
    for (const r of rows) if ((await queueEmail(r.id, "initial", "auto")).ok) n++;
  }
  if (s.auto_followup_days > 0) {
    const rows = await q<{ id: string }>(
      `select id from leads where status = 'contacted' and followups_sent = 0 and replied_at is null
         and contacted_at < now() - make_interval(days => $1) limit 50`,
      [s.auto_followup_days],
    );
    for (const r of rows) if ((await queueEmail(r.id, "followup", "auto-followup")).ok) n++;
  }
  return n;
}

// ---------------- The heartbeat ----------------

export async function tick(opts: { forceIngest?: boolean } = {}) {
  const out: Record<string, string> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      out[name] = String(await fn());
    } catch (e) {
      out[name] = `error: ${(e as Error).message}`;
      await logRun("system", false, `${name}: ${(e as Error).message}`);
    }
  };
  await setSetting("last_tick_at", new Date().toISOString());
  await step("ingest", () => ingest(opts.forceIngest));
  await step("enrich", () => enrichPending());
  await step("poll", () => pollEnrichment());
  await step("inbox", async () => {
    if (!(await lease("inbox", 50))) return "busy";
    try {
      const r = await checkInbox();
      return r ? `${r.matched} replies` : "no mailbox";
    } finally {
      await release("inbox");
    }
  });
  await step("autoQueue", () => autoQueue());
  await step("send", () => processQueue());
  return out;
}
