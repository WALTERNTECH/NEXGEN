import "server-only";
import {
  appUrl,
  CATEGORIES,
  CATEGORY_LABEL,
  getSettings,
  getSetting,
  setSetting,
  getTemplate,
  templateSaved,
  secret,
  type Category,
} from "./config";
import { q, one, tx, lease, release } from "./db";
import { searchCategory, docketUrl, ymd, RateLimited, type ClDocket } from "./courtlistener";
import { splitFullName } from "./extract";
import { companyFor, heuristicExtract, llmRefine } from "./extract";
import { caseDetails } from "./figures";
import { money } from "./render";
import { enrich, result, leadIdOf, GOOD_EMAIL, type BcResult } from "./bettercontact";
import { render, sendMail, mailReady, type LeadVars } from "./mailer";
import { checkInbox } from "./inbox";
import { notify } from "./push";
import { logRun } from "./runs";

const MAX_NEW_PER_CATEGORY = 40;

/*
 * Lead statuses
 *   pending_details        stored, case documents not read yet (owner name may come from them)
 *   discovered             incoming lead with an owner name, waiting for BetterContact
 *   not_enriched_backfill  historical backfill lead: never sent to BetterContact automatically (Update A)
 *   enriching / enriched / enrichment_failed / contacted / replied / unsubscribed
 */

// ---------------- Module A: discovery (incoming + backfill) ----------------

/** Save one docket as a lead. Returns true when it was new. Case documents are read later by the details worker. */
async function storeDocket(cat: Category, d: ClDocket, backfill: boolean): Promise<"new" | "known" | "skip"> {
  const company = companyFor(cat, d);
  if (!company) return "skip";
  const x = heuristicExtract(cat, d, company, []);
  const status = x.founderFullName ? (backfill ? "not_enriched_backfill" : "discovered") : "pending_details";
  const ins = await q(
    `insert into leads (external_case_id, category, case_name, case_number, court_id, court_name, company_name, distress_type,
       creditor_summary, filing_date, insolvency_stage, founder_full_name, founder_first_name, founder_last_name, founder_title,
       founder_source, status, cl_url, raw, is_historical_backfill, judge, trustee, seen_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, case when $20 then now() end)
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
      x.creditorSummary,
      d.dateFiled ?? null,
      x.insolvencyStage,
      x.founderFullName,
      x.founderFirstName,
      x.founderLastName,
      x.founderTitle,
      x.founderSource,
      status,
      docketUrl(d),
      JSON.stringify({ party: d.party?.slice(0, 40), suitNature: d.suitNature, cause: d.cause, chapter: d.chapter, docket_id: d.docket_id, docket_absolute_url: d.docket_absolute_url }),
      backfill,
      d.assignedTo || null,
      d.trustee_str || null,
    ],
  );
  return ins.length ? "new" : "known";
}

/** Incoming live crawl: only the newest filings (look-back in days, default 2). These get enriched automatically. */
export async function ingest(force = false): Promise<string> {
  const s = await getSettings();
  // Each category is checked on its own schedule, so a rate-limited minute only delays the categories it didn't reach.
  const state = (await getSetting<Partial<Record<Category, string>>>("ingest_state")) ?? {};
  const due = CATEGORIES.filter(
    (c) => s.categories[c]?.on && s.categories[c].query.trim() && (force || !state[c] || Date.now() - Date.parse(state[c]!) >= s.ingest_every_min * 60_000),
  );
  if (!due.length) return "not due";
  if (!(await secret("COURTLISTENER_API_KEY"))) return "no CourtListener key";
  if (!(await lease("ingest", 120))) return "already running";
  try {
    await setSetting("last_ingest_at", new Date().toISOString());
    const after = ymd(new Date(Date.now() - s.lookback_days * 86_400_000));
    const added: Record<Category, number> = { court: 0, tax: 0, debt: 0 };
    const errors: string[] = [];
    let limited = false;
    const seen: Partial<Record<Category, { found: number; known: number; skipped: number }>> = {};
    for (const cat of due) {
      const conf = s.categories[cat];
      try {
        const { dockets, count } = await searchCategory(cat, conf.query, { after, maxPages: 2 });
        const st = { found: count ?? dockets.length, known: 0, skipped: 0 };
        for (const d of dockets) {
          if (added[cat] >= MAX_NEW_PER_CATEGORY) break;
          const r = await storeDocket(cat, d, false);
          if (r === "new") added[cat]++;
          else if (r === "known") st.known++;
          else st.skipped++;
        }
        seen[cat] = st;
        state[cat] = new Date().toISOString();
      } catch (e) {
        if (e instanceof RateLimited) {
          limited = true;
          break;
        }
        // A timeout is CourtListener being slow: try again next minute instead of waiting a full interval.
        if (!/timeout|aborted/i.test((e as Error).message)) state[cat] = new Date().toISOString();
        errors.push(`${CATEGORY_LABEL[cat]}: ${(e as Error).message}`);
      }
    }
    await setSetting("ingest_state", state);
    const total0 = added.court + added.tax + added.debt;
    if (limited && total0 === 0 && !errors.length) return "waiting for CourtListener rate limit";
    const total = added.court + added.tax + added.debt;
    const summary =
      `Incoming: ${total} new lead${total === 1 ? "" : "s"}` +
      (Object.keys(seen).length
        ? " — " +
          (Object.entries(seen) as [Category, { found: number; known: number; skipped: number }][])
            .map(([c, v]) => `${CATEGORY_LABEL[c]}: ${added[c]} new of ${v.found} matching filings (${v.known} already saved, ${v.skipped} not a distressed business)`)
            .join("; ")
        : "") +
      (errors.length ? ` — ${errors.join("; ")}` : "");
    await logRun("ingest", errors.length === 0, summary, { added, errors, after, seen });
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

export interface BackfillJob {
  from: string;
  to: string;
  categories: Category[];
  cursors: Partial<Record<Category, string | null>>;
  done: Category[];
  added: Record<Category, number>;
  scanned: number;
  status: "running" | "done" | "cancelled" | "error";
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
}

export async function startBackfill(from: string, to: string, categories: Category[]) {
  const job: BackfillJob = {
    from,
    to,
    categories,
    cursors: {},
    done: [],
    added: { court: 0, tax: 0, debt: 0 },
    scanned: 0,
    status: "running",
    started_at: new Date().toISOString(),
  };
  await setSetting("backfill", job);
  await logRun("ingest", true, `Backfill started: ${from} → ${to} (${categories.map((c) => CATEGORY_LABEL[c]).join(", ")}) — no automatic enrichment`);
  return job;
}

/** Historical backfill: one page per category per run, stored as NOT_ENRICHED_BACKFILL (Update A). */
export async function processBackfill(budgetMs = 20_000): Promise<string> {
  const job = await getSetting<BackfillJob>("backfill");
  if (!job || job.status !== "running") return "idle";
  if (!(await secret("COURTLISTENER_API_KEY"))) return "no key";
  if (!(await lease("backfill", 90))) return "busy";
  const t0 = Date.now();
  try {
    const s = await getSettings();
    for (const cat of job.categories) {
      if (job.done.includes(cat) || Date.now() - t0 > budgetMs) continue;
      const cursor = job.cursors[cat];
      const page = await searchCategory(cat, s.categories[cat].query, { after: job.from, before: job.to, cursor: cursor ?? null, maxPages: 1 });
      for (const d of page.dockets) {
        job.scanned++;
        if ((await storeDocket(cat, d, true)) === "new") job.added[cat]++;
      }
      job.cursors[cat] = page.next;
      if (!page.next) job.done.push(cat);
    }
    if (job.categories.every((c) => job.done.includes(c))) {
      job.status = "done";
      job.finished_at = new Date().toISOString();
      const n = job.added.court + job.added.tax + job.added.debt;
      await logRun("ingest", true, `Backfill finished: ${n} historical lead${n === 1 ? "" : "s"} saved (not enriched)`, job.added);
      await notify({ title: "Backfill finished", body: `${n} historical leads saved — enrich any of them from the lead page`, url: "/leads?source=backfill", tag: "backfill" });
    }
    await setSetting("backfill", job);
    return `backfill ${job.status} (+${job.added.court + job.added.tax + job.added.debt})`;
  } catch (e) {
    job.status = "error";
    job.error = (e as Error).message;
    await setSetting("backfill", job);
    await logRun("ingest", false, `Backfill stopped: ${job.error}`);
    return job.error;
  } finally {
    await release("backfill");
  }
}

// ---------------- Update C: case details worker ----------------

interface DetailRow {
  [k: string]: unknown;
  id: string;
  category: Category;
  external_case_id: string;
  company_name: string;
  founder_full_name: string | null;
  status: string;
  is_historical_backfill: boolean;
  raw: { docket_id?: number; party?: string[]; suitNature?: string; cause?: string; chapter?: string | number | null; docket_absolute_url?: string } | null;
  case_name: string;
  case_number: string | null;
  court_id: string | null;
  court_name: string | null;
  filing_date: string | null;
  judge: string | null;
  trustee: string | null;
  cl_url: string | null;
}

/** The docket as CourtListener's search returned it, rebuilt from the stored lead — no extra API call. */
function docketFromRow(r: DetailRow): ClDocket {
  return {
    docket_id: Number(r.raw?.docket_id ?? r.external_case_id),
    caseName: r.case_name,
    docketNumber: r.case_number ?? undefined,
    court: r.court_name ?? undefined,
    court_id: r.court_id ?? undefined,
    dateFiled: r.filing_date ?? undefined,
    chapter: r.raw?.chapter ?? null,
    suitNature: r.raw?.suitNature,
    cause: r.raw?.cause,
    party: r.raw?.party ?? [],
    assignedTo: r.judge ?? undefined,
    trustee_str: r.trustee ?? undefined,
    docket_absolute_url: r.raw?.docket_absolute_url,
  };
}

/** Reads docket entries and public filing text for new leads, and re-checks recent bankruptcies daily until their schedules appear. */
export async function refreshDetails(budgetMs = 25_000, onlyId?: string): Promise<string> {
  if (!(await secret("COURTLISTENER_API_KEY"))) return "no key";
  if (!onlyId && !(await lease("details", 60))) return "busy";
  const t0 = Date.now();
  let n = 0;
  try {
    const rows = await q<DetailRow>(
      onlyId
        ? `select id, category, external_case_id, company_name, founder_full_name, status, is_historical_backfill, raw, case_name, case_number, court_id, court_name, filing_date::text as filing_date, judge, trustee, cl_url from leads where id = $1`
        : `select id, category, external_case_id, company_name, founder_full_name, status, is_historical_backfill, raw, case_name, case_number, court_id, court_name, filing_date::text as filing_date, judge, trustee, cl_url from leads
           where details_checked_at is null
              or ((debt_amount is null or founder_full_name is null) and filing_date > current_date - 60 and details_checked_at < now() - interval '20 hours')
           order by (details_checked_at is null) desc, is_historical_backfill asc, created_at desc limit 12`,
      onlyId ? [onlyId] : [],
    );
    for (const r of rows) {
      if (Date.now() - t0 > budgetMs) break;
      const d = docketFromRow(r);
      let det;
      try {
        det = await caseDetails(r.category, d, !r.founder_full_name);
      } catch (e) {
        if (e instanceof RateLimited) break; // not marked as checked: picked up again next minute
        throw e;
      }
      // A signer named in the documents fills in a missing owner.
      let founder: { full: string; first: string; last: string; title: string | null; source: string } | null = null;
      if (!r.founder_full_name && det.signer) {
        const n = splitFullName(det.signer.name);
        if (n.last) founder = { full: det.signer.name, first: n.first, last: n.last, title: det.signer.title, source: det.signer.source };
      }
      if (!r.founder_full_name && !founder) {
        let x = heuristicExtract(r.category, d, r.company_name, det.entries);
        if (!x.founderFullName) x = await llmRefine(r.category, d, det.entries, x);
        if (x.founderFullName && x.founderFirstName && x.founderLastName)
          founder = { full: x.founderFullName, first: x.founderFirstName, last: x.founderLastName, title: x.founderTitle, source: x.founderSource ?? "court document" };
      }
      const nextStatus =
        founder && (r.status === "pending_details" || r.status === "enrichment_failed")
          ? r.is_historical_backfill
            ? "not_enriched_backfill"
            : "discovered"
          : r.status === "pending_details"
            ? "enrichment_failed"
            : r.status;
      await q(
        `update leads set
           debt_amount = coalesce($2, debt_amount), debt_amount_text = coalesce($3, debt_amount_text), tax_debt = coalesce($4, tax_debt),
           secured_debt = coalesce($5, secured_debt), unsecured_debt = coalesce($6, unsecured_debt), priority_debt = coalesce($7, priority_debt),
           liabilities_range = coalesce($8, liabilities_range), figures_source = coalesce($9, figures_source),
           judge = coalesce($10, judge), trustee = coalesce($11, trustee), dba = coalesce($12, dba),
           case_summary = $13, case_notes = $14, details_checked_at = now(),
           founder_full_name = coalesce(founder_full_name, $15), founder_first_name = coalesce(founder_first_name, $16),
           founder_last_name = coalesce(founder_last_name, $17), founder_title = coalesce(founder_title, $18), founder_source = coalesce(founder_source, $19),
           status = $20, updated_at = now()
         where id = $1`,
        [
          r.id,
          det.total,
          det.total ? money(det.total) : det.range,
          det.tax,
          det.secured,
          det.unsecured,
          det.priority,
          det.range,
          det.source,
          det.judge,
          det.trustee,
          det.dba,
          det.summary,
          JSON.stringify(det.notes),
          founder?.full ?? null,
          founder?.first ?? null,
          founder?.last ?? null,
          founder?.title ?? null,
          founder?.source ?? null,
          nextStatus,
        ],
      );
      n++;
    }
    return `${n} case${n === 1 ? "" : "s"} read`;
  } finally {
    if (!onlyId) await release("details");
  }
}

// ---------------- Module B: enrichment (incoming only, Update A) ----------------

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
  category: Category;
  is_historical_backfill: boolean;
}

/**
 * Automatic runs pick incoming leads only (is_historical_backfill = false). Backfill leads reach BetterContact
 * only through an explicit "Enrich now" on that one lead (onlyId).
 */
export async function enrichPending(only?: string | string[]): Promise<string> {
  const ids = only === undefined ? null : Array.isArray(only) ? only : [only];
  if (!(await secret("BETTERCONTACT_API_KEY"))) return "no BetterContact key";
  const rows = await q<LeadRow>(
    `select * from leads where status = 'discovered' and founder_first_name is not null and founder_last_name is not null
       and founder_last_name <> '' and bc_job_id is null ${ids ? "and id = any($1)" : "and is_historical_backfill = false"}
     order by created_at limit 50`,
    ids ? [ids] : [],
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
    await logRun("enrich", true, `Sent ${rows.length} ${ids ? `lead${rows.length === 1 ? "" : "s"} (Enrich now)` : `incoming founder${rows.length === 1 ? "" : "s"}`} to BetterContact`, { request_id: id });
    return `sent ${rows.length}`;
  } catch (e) {
    // Put a manual request back where it was so it can be retried.
    if (ids) await q(`update leads set status = case when is_historical_backfill then 'not_enriched_backfill' else 'enrichment_failed' end where id = any($1) and status = 'discovered'`, [ids]);
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
    if (emailSaved && s.categories[lead.category]?.auto_send && (await templateSaved(lead.category))) await queueEmail(leadId, "initial", "auto");
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

// ---------------- Module C / Update D: zero-duplicate outreach ----------------

export type EmailKind = "initial" | "followup";

/**
 * Lock 1 + Lock 2 in one transaction: lock the lead row, verify its send state, then reserve a log row.
 * Unique indexes make a second new-lead email impossible per lead AND per address, even across parallel requests.
 */
export async function queueEmail(leadId: string, kind: EmailKind, origin: "auto" | "bulk" | "manual" | "auto-followup") {
  try {
    return await tx(async (t) => {
      const lead = (await t.query<LeadRow>(`select * from leads where id = $1 for update`, [leadId])).rows[0];
      if (!lead || !lead.direct_email) return { ok: false, reason: "No verified email" };
      if (lead.status === "unsubscribed") return { ok: false, reason: "Unsubscribed" };
      if (kind === "initial" && lead.auto_email_sent) return { ok: false, reason: "Already contacted" };
      if (kind === "followup" && !lead.auto_email_sent) return { ok: false, reason: "Send the new-lead email first" };
      const r = await t.query(
        `insert into email_log (lead_id, kind, recipient_email, status, origin) values ($1, $2, $3, 'queued', $4)
         on conflict do nothing returning id`,
        [leadId, kind, lead.direct_email.toLowerCase(), origin],
      );
      return r.rows.length ? { ok: true } : { ok: false, reason: kind === "initial" ? "Already emailed" : "Follow-up already waiting" };
    });
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
    await q(`update email_log set status = 'failed', error = 'Interrupted — check Sent folder before retrying' where status = 'sending' and created_at < now() - interval '15 minutes'`);
    let sent = 0;
    const t0 = Date.now();
    while (sent < max && Date.now() - t0 < 40_000) {
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
        await q(`update email_log set status = 'cancelled', error = $2 where id = $1`, [
          job.id,
          !lead ? "Lead removed" : lead.status === "unsubscribed" ? "Unsubscribed" : "Already contacted",
        ]);
        continue;
      }
      const tpl = await getTemplate(job.kind, lead.category);
      const subject = render(tpl.subject, lead, s);
      const body = render(tpl.body, lead, s);
      const thread =
        job.kind === "followup"
          ? (
              await one<{ message_id: string }>(
                `select message_id from email_log where lead_id = $1 and status = 'sent' and message_id is not null order by sent_at desc limit 1`,
                [lead.id],
              )
            )?.message_id
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
        await logRun("send", true, `${CATEGORY_LABEL[lead.category]} ${job.kind === "initial" ? "new-lead email" : "follow-up"} sent to ${job.recipient_email} (${lead.company_name})`, {
          lead_id: lead.id,
          log_id: job.id,
        });
      } catch (e) {
        await q(`update email_log set status = 'failed', error = $2 where id = $1`, [job.id, (e as Error).message.slice(0, 400)]);
        await logRun("send", false, `Sending to ${job.recipient_email} failed: ${(e as Error).message}`);
        break;
      }
      if (s.send_gap_min > 0) break;
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

/** Update D: categories with Auto-Send on (and a saved template) email every eligible enriched lead in that category, once. */
export async function autoQueue(): Promise<number> {
  const s = await getSettings();
  let n = 0;
  for (const cat of CATEGORIES) {
    if (!s.categories[cat]?.auto_send || !(await templateSaved(cat))) continue;
    const rows = await q<{ id: string }>(
      `select id from leads where category = $1 and status = 'enriched' and direct_email is not null and auto_email_sent = false
         and not exists (select 1 from email_log e where e.lead_id = leads.id and e.kind = 'initial')
       order by updated_at limit 50`,
      [cat],
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
  const t0 = Date.now();
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
  await step("details", () => refreshDetails(Math.max(5_000, 30_000 - (Date.now() - t0))));
  await step("enrich", () => enrichPending());
  await step("poll", () => pollEnrichment());
  await step("backfill", () => processBackfill(Math.max(3_000, 40_000 - (Date.now() - t0))));
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
