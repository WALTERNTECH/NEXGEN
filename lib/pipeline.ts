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
import { companyFor, individualFor, heuristicExtract, llmRefine } from "./extract";
import { caseDetails } from "./figures";
import { money } from "./render";
import { enrich, result, account, leadIdOf, leadFinder, leadFinderResult, GOOD_EMAIL, type BcResult, type LfResult, type LfLead } from "./bettercontact";
import { hunterEmailFinder, hunterDomainSearch } from "./sources";
import { findOwner, findWebsite } from "./owners";
import { importCdtfa, importSba } from "./importers";
import { importStateTaxes } from "./statetax";
import { runApifyFeeds } from "./apify";
import { render, sendMail, mailReady, type LeadVars } from "./mailer";
import { checkInbox } from "./inbox";
import { sealText } from "./privacy";
import { currentCheck, warmupCap, inUsBusinessHours, nextSendAllowed, scheduleNextSend, sendPaused } from "./deliverability";
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
async function storeDocket(cat: Category, d: ClDocket, backfill: boolean, research = true): Promise<"new" | "known" | "skip"> {
  let company = companyFor(cat, d);
  let individual = false;
  let x;
  if (company) {
    x = heuristicExtract(cat, d, company, []);
  } else {
    // A person sued by the United States (tax) or by a lender (debt), or an individual Chapter 11 debtor.
    const p = individualFor(cat, d);
    if (!p) return "skip";
    individual = true;
    company = p.name;
    x = { ...heuristicExtract(cat, d, p.name, []), founderFullName: p.name, founderFirstName: p.first, founderLastName: p.last, founderTitle: "Individual (defendant/debtor)", founderSource: "case caption" };
  }
  // Individuals wait for the amount (kept only at or above the minimum); companies go straight to research.
  const status = individual ? "pending_details" : backfill && !research ? "not_enriched_backfill" : "researching";
  const ins = await q(
    `insert into leads (external_case_id, category, case_name, case_number, court_id, court_name, company_name, distress_type,
       creditor_summary, filing_date, insolvency_stage, founder_full_name, founder_first_name, founder_last_name, founder_title,
       founder_source, status, cl_url, raw, is_historical_backfill, judge, trustee, seen_at, is_individual)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, case when $20 then now() end, $23)
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
      individual,
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
        const { dockets, count } = await searchCategory(cat, conf.query, { after, maxPages: 1 });
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
  await logRun("ingest", true, `Backfill started: ${from} → ${to} (${categories.map((c) => CATEGORY_LABEL[c]).join(", ")}) — ${(await getSettings()).enrich_backfill ? "researched for emails as they arrive" : "saved without contact searches"}`);
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
        if ((await storeDocket(cat, d, true, s.enrich_backfill)) === "new") job.added[cat]++;
      }
      job.cursors[cat] = page.next;
      if (!page.next) job.done.push(cat);
    }
    if (job.categories.every((c) => job.done.includes(c))) {
      job.status = "done";
      job.finished_at = new Date().toISOString();
      const n = job.added.court + job.added.tax + job.added.debt;
      await logRun("ingest", true, `Backfill finished: ${n} historical lead${n === 1 ? "" : "s"} saved (not enriched)`, job.added);
      await notify({ title: "Backfill finished", body: `${n} historical filings scanned — complete leads appear as their emails are found`, url: "/leads?source=backfill", tag: "backfill" });
    }
    await setSetting("backfill", job);
    return `backfill ${job.status} (+${job.added.court + job.added.tax + job.added.debt})`;
  } catch (e) {
    // CourtListener's per-minute/hour limits only pause the backfill; it continues on the next free minute.
    if (e instanceof RateLimited || /timeout|aborted/i.test((e as Error).message)) {
      await setSetting("backfill", job);
      return `backfill waiting for CourtListener (+${job.added.court + job.added.tax + job.added.debt} so far)`;
    }
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
        ? `select id, category, external_case_id, company_name, founder_full_name, status, is_historical_backfill, raw, case_name, case_number, court_id, court_name, filing_date::text as filing_date, judge, trustee, cl_url, is_individual, direct_email, debt_amount, owner_lookup_at from leads where id = $1`
        : `select id, category, external_case_id, company_name, founder_full_name, status, is_historical_backfill, raw, case_name, case_number, court_id, court_name, filing_date::text as filing_date, judge, trustee, cl_url, is_individual, direct_email, debt_amount, owner_lookup_at from leads
           where source = 'courtlistener' and (not is_historical_backfill or direct_email is not null or is_individual)
             and (details_checked_at is null
                  or ((debt_amount is null or founder_full_name is null) and filing_date > current_date - 45 and details_checked_at < now() - interval '3 days'))
           order by (direct_email is not null and details_checked_at is null) desc, (is_individual and details_checked_at is null) desc,
                    (details_checked_at is null) desc, is_historical_backfill asc, created_at desc limit 12`,
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
      const settings = await getSettings();
      const amount = det.total ?? (r.debt_amount as number | null);
      let nextStatus = r.status;
      let reResearch = false;
      if (r.is_individual) {
        if (amount && amount >= settings.individual_min_amount) {
          if (!r.direct_email && ["pending_details", "enrichment_failed", "below_minimum"].includes(r.status)) nextStatus = "researching";
        } else if (amount) nextStatus = "below_minimum";
        else if (r.status === "pending_details") nextStatus = "enrichment_failed";
      } else {
        if (r.status === "pending_details") nextStatus = "researching";
        // A newly found signer gets a fresh contact search.
        if (founder && !r.direct_email && r.status === "enrichment_failed") {
          nextStatus = "researching";
          reResearch = true;
        }
      }
      await q(
        `update leads set
           debt_amount = coalesce($2, debt_amount), debt_amount_text = coalesce($3, debt_amount_text), tax_debt = coalesce($4, tax_debt),
           secured_debt = coalesce($5, secured_debt), unsecured_debt = coalesce($6, unsecured_debt), priority_debt = coalesce($7, priority_debt),
           liabilities_range = coalesce($8, liabilities_range), figures_source = coalesce($9, figures_source),
           judge = coalesce($10, judge), trustee = coalesce($11, trustee), dba = coalesce($12, dba),
           case_summary = $13, case_notes = $14, details_checked_at = now(),
           founder_full_name = coalesce(founder_full_name, $15), founder_first_name = coalesce(founder_first_name, $16),
           founder_last_name = coalesce(founder_last_name, $17), founder_title = coalesce(founder_title, $18), founder_source = coalesce(founder_source, $19),
           status = $20, owner_lookup_at = case when $21 then null else owner_lookup_at end, updated_at = now()
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
          reResearch,
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
  if (!only && (await bcPaused())) return "paused (no credits)";
  const rows = await q<LeadRow>(
    `select * from leads where status = 'discovered' and founder_first_name is not null and founder_last_name is not null
       and founder_last_name <> '' and bc_job_id is null ${ids ? "and id = any($1)" : ""}
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
      (await getSettings()).find_phones,
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
    if (/credit|402/i.test((e as Error).message)) await pauseBc("no credits left");
    await logRun("enrich", false, (e as Error).message);
    return (e as Error).message;
  }
}

/** Apply a terminated BetterContact result. Safe to call any number of times for the same result. */
export async function applyEnrichment(res: BcResult, via: "webhook" | "poll"): Promise<number> {
  if (res.status !== "terminated" || !res.data) return 0;
  await noteCredits(res.credits_left);
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
      if (j.bc_job_id.startsWith("lf:")) {
        const r = await leadFinderResult(j.bc_job_id.slice(3));
        if (r.status === "terminated") {
          await applyLeadFinder({ ...r, id: j.bc_job_id.slice(3) }, "poll");
          done++;
        } else if (r.status === "unknown" || Date.now() - Date.parse(j.started) > 6 * 3600_000) {
          await q(`update leads set status = 'enrichment_failed', updated_at = now() where bc_job_id = $1 and status = 'enriching'`, [j.bc_job_id]);
        }
        continue;
      }
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

// ---------------- Research: owner → website → email (registries, Google, Hunter.io, BetterContact) ----------------

interface ResearchRow {
  [k: string]: unknown;
  id: string;
  company_name: string;
  court_id: string | null;
  status: string;
  is_historical_backfill: boolean;
  is_individual: boolean;
  company_domain: string | null;
  dba: string | null;
  founder_full_name: string | null;
  founder_first_name: string | null;
  founder_last_name: string | null;
  founder_title: string | null;
  biz_state: string | null;
}

/** BetterContact is paused after it reports no credits; re-checked once an hour (free account call). */
export async function bcPaused(): Promise<string | null> {
  const p = await getSetting<{ at: string; reason: string }>("bc_paused");
  if (!p) return null;
  if (Date.now() - Date.parse(p.at) < 3600_000) return p.reason;
  try {
    const a = await account();
    if ((a.credits_left ?? 0) >= 1) {
      await q(`delete from settings where key = 'bc_paused'`);
      await setSetting("bc_credits", { left: a.credits_left, at: new Date().toISOString() });
      await logRun("enrich", true, `BetterContact credits available again (${a.credits_left}) — contact searches resumed`);
      return null;
    }
  } catch {}
  await setSetting("bc_paused", { at: new Date().toISOString(), reason: p.reason });
  return p.reason;
}

export async function pauseBc(reason: string) {
  if (await getSetting("bc_paused")) return;
  await setSetting("bc_paused", { at: new Date().toISOString(), reason });
  await logRun("enrich", false, `BetterContact paused: ${reason}. Searches resume when credits are added.`);
  await notify({ title: "BetterContact credits used up", body: "NEXGEN paused paid contact searches. Free sources keep running.", url: "/settings", tag: "bc-credits" });
}

export async function noteCredits(left: number | undefined) {
  if (typeof left !== "number") return;
  await setSetting("bc_credits", { left, at: new Date().toISOString() });
  if (left < 1) await pauseBc("no credits left");
}

async function hunterPaused() {
  const until = await getSetting<string>("hunter_paused_until");
  return Boolean(until && Date.parse(until) > Date.now());
}

/** Store an email found by a direct source (Hunter). Only on a lead that has none yet; the address may belong to one lead only. */
async function setFoundEmail(
  leadId: string,
  f: { email: string; first: string | null; last: string | null; title: string | null; source: string; domain: string | null },
): Promise<boolean> {
  const taken = await one(`select id from leads where direct_email = $1 and id <> $2`, [f.email, leadId]);
  if (taken) return false;
  const full = f.first && f.last ? `${f.first} ${f.last}` : null;
  const r = await q(
    `update leads set direct_email = $2, email_status = 'valid', contact_source = $3, company_domain = coalesce(company_domain, $4),
       founder_full_name = coalesce(founder_full_name, $5), founder_first_name = coalesce(founder_first_name, $6),
       founder_last_name = coalesce(founder_last_name, $7), founder_title = coalesce(founder_title, $8),
       founder_source = coalesce(founder_source, $3), status = 'enriched', updated_at = now()
     where id = $1 and direct_email is null returning id`,
    [leadId, f.email, f.source, f.domain, full, f.first, f.last, f.title],
  ).catch((e) => {
    if (String(e.code) === "23505") return [];
    throw e;
  });
  return r.length > 0;
}

/**
 * Research, many companies at once, cheapest source first:
 *   1. owner name: filing → free state registries → OpenCorporates (if key) → Google (Serper, if key)
 *   2. website:    free .com check → Google (Serper)            (looked up at the same time as the owner)
 *   3. email:      Hunter.io (if key, free 25/month) → BetterContact (name search, or Lead Finder on the website)
 * Companies are claimed before they're searched, so parallel runs never work on the same one.
 * Most promising first: an owner already named, then the largest amount owed, then the newest filing.
 */
export async function findOwners(onlyId?: string, budgetMs = 20_000, opts: { batch?: number; concurrency?: number } = {}): Promise<string> {
  const t0 = Date.now();
  const s = await getSettings();
  const batch = opts.batch ?? 8;
  const concurrency = opts.concurrency ?? 4;
  const COLS = `id, company_name, court_id, status, is_historical_backfill, is_individual, company_domain, dba,
            founder_full_name, founder_first_name, founder_last_name, founder_title, biz_state`;
  const rows = onlyId
    ? await q<ResearchRow>(`select ${COLS} from leads where id = $1`, [onlyId])
    : await q<ResearchRow>(
        `update leads set research_claimed_at = now()
         where id in (
           select id from leads
           where status = 'researching' and direct_email is null ${s.enrich_backfill ? "" : "and is_historical_backfill = false"}
             and (research_claimed_at is null or research_claimed_at < now() - interval '15 minutes')
           order by is_historical_backfill asc, (founder_full_name is not null) desc, debt_amount desc nulls last, filing_date desc nulls last
           limit $1
           for update skip locked)
         returning ${COLS}`,
        [batch],
      );
  if (!rows.length) return "nothing to research";
  const bcKey = await secret("BETTERCONTACT_API_KEY");
  const hunterKey = (await secret("HUNTER_API_KEY")) && !(await hunterPaused());
  const lfOff = Boolean(await getSetting("lf_unavailable"));
  const done = { emails: 0, names: 0, bc: 0, lf: 0, none: 0 };

  const researchOne = async (r: ResearchRow) => {
    const note: string[] = [];
    // An individual is searched through the business they're connected to (d/b/a), when the filing gives one.
    const company = r.is_individual ? r.dba : r.company_name;
    // Where the business is: its own address (tax/loan records) or the court's state.
    const where = r.biz_state ? r.biz_state.toLowerCase() : r.court_id;
    if (!company) {
      await q(`update leads set status = 'enrichment_failed', owner_lookup_at = now(), owner_lookup_note = 'individual with no business named in the filing', updated_at = now() where id = $1`, [r.id]);
      done.none++;
      return;
    }
    let name = r.founder_full_name && r.founder_first_name && r.founder_last_name ? { name: r.founder_full_name, first: r.founder_first_name, last: r.founder_last_name, title: r.founder_title ?? "", source: "" } : null;
    // Owner and website are looked up at the same time.
    const [ownerRes, domain] = await Promise.all([name ? Promise.resolve(null) : findOwner(company, where), r.company_domain ? Promise.resolve(r.company_domain) : findWebsite(company, where)]);
    if (ownerRes) {
      note.push(`checked ${ownerRes.tried.join(", ") || "filing"}`);
      if (ownerRes.hit) {
        name = ownerRes.hit;
        done.names++;
        note.push(`owner ${ownerRes.hit.name} (${ownerRes.hit.source})`);
        await q(
          `update leads set founder_full_name = $2, founder_first_name = $3, founder_last_name = $4, founder_title = $5, founder_source = $6, updated_at = now() where id = $1`,
          [r.id, ownerRes.hit.name, ownerRes.hit.first, ownerRes.hit.last, ownerRes.hit.title, ownerRes.hit.source],
        );
      }
    }
    note.push(domain ? `website ${domain}` : "no website");
    if (domain && !r.company_domain) await q(`update leads set company_domain = $2 where id = $1`, [r.id, domain]);

    // Hunter.io first while its free monthly searches last — only on a website NEXGEN verified as this company.
    if (hunterKey && domain && !(await hunterPaused())) {
      try {
        const f = name ? await hunterEmailFinder(name.first, name.last, domain) : await hunterDomainSearch(domain);
        if (f && (await setFoundEmail(r.id, f))) {
          done.emails++;
          note.push(`email via ${f.source}`);
          await q(`update leads set owner_lookup_at = now(), owner_lookup_note = $2 where id = $1`, [r.id, note.join(" · ")]);
          await afterContact(r.id);
          return;
        }
      } catch (e) {
        if (/limit/.test((e as Error).message) && !(await hunterPaused())) {
          const d = new Date();
          await setSetting("hunter_paused_until", new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString());
          await logRun("enrich", false, "Hunter.io monthly searches used up — paused until next month");
        }
      }
    }

    // Then BetterContact, while credits last.
    const paused = bcKey ? await bcPaused() : "no key";
    if (bcKey && !paused) {
      if (name) {
        done.bc++;
        note.push("searching BetterContact by name");
        await q(`update leads set status = 'discovered', bc_job_id = null, owner_lookup_at = now(), owner_lookup_note = $2, updated_at = now() where id = $1`, [r.id, note.join(" · ")]);
        return;
      }
      if (domain && !lfOff && !(await getSetting("lf_unavailable"))) {
        try {
          const id = await leadFinder(domain, webhookUrl(), s.find_phones);
          done.lf++;
          note.push("searching owner at website (BetterContact)");
          await q(
            `update leads set owner_lookup_at = now(), owner_lookup_note = $2, bc_job_id = $3, status = 'enriching',
               enrich_started_at = now(), enrich_attempts = enrich_attempts + 1, updated_at = now() where id = $1`,
            [r.id, note.join(" · "), `lf:${id}`],
          );
          return;
        } catch (e) {
          const m = (e as Error).message;
          if (/out of free lead finder|upgrade your plan/i.test(m)) {
            await setSetting("lf_unavailable", { at: new Date().toISOString(), reason: "BetterContact free plan: Lead Finder searches used up" });
            await logRun("enrich", false, "BetterContact Lead Finder (search by website) is used up on the free plan — name searches continue");
          } else if (/402|credit/i.test(m)) await pauseBc("no credits left");
          else await logRun("enrich", false, `Lead Finder for ${company}: ${m}`);
        }
      }
    } else if (paused && (name || domain)) {
      // Keep it for later, but step aside for 6 hours so it doesn't block the queue.
      note.push(`waiting for BetterContact (${paused})`);
      await q(`update leads set owner_lookup_note = $2, research_claimed_at = now() + interval '6 hours', updated_at = now() where id = $1`, [r.id, note.join(" · ")]);
      return;
    }
    done.none++;
    await q(`update leads set status = 'enrichment_failed', owner_lookup_at = now(), owner_lookup_note = $2, updated_at = now() where id = $1`, [r.id, note.join(" · ")]);
  };

  // A small worker pool: `concurrency` companies in flight, stop starting new ones when the time budget is spent.
  let next = 0;
  const worker = async () => {
    while (next < rows.length && Date.now() - t0 < budgetMs) {
      const r = rows[next++];
      try {
        await researchOne(r);
      } catch (e) {
        await logRun("enrich", false, `Research for ${r.company_name}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  // Anything claimed but not reached goes back to the queue right away.
  const untouched = rows.slice(next).map((r) => r.id);
  if (untouched.length) await q(`update leads set research_claimed_at = null where id = any($1)`, [untouched]);

  if (done.emails || done.names || done.bc || done.lf)
    await logRun(
      "enrich",
      true,
      `Research: ${next} companies — ${done.emails} email${done.emails === 1 ? "" : "s"} found directly, ${done.names} owner name${done.names === 1 ? "" : "s"} found, ${done.bc} sent to BetterContact, ${done.lf} website search${done.lf === 1 ? "" : "es"}, ${done.none} with nothing to search`,
    );
  return `${next} researched in ${Math.round((Date.now() - t0) / 1000)}s (${done.emails} emails, ${done.bc + done.lf} to BetterContact, ${done.none} no contact)`;
}


/** A lead just got an email: alert, read its case figures next, and queue the category email if Auto-Send is on. */
async function afterContact(leadId: string) {
  const lead = await one<LeadRow>(`select * from leads where id = $1`, [leadId]);
  if (!lead?.direct_email) return;
  await notify({
    title: `Contact found — ${lead.company_name}`,
    body: [lead.founder_full_name, lead.direct_email].filter(Boolean).join(" · "),
    url: `/leads?lead=${leadId}`,
    tag: `contact-${leadId}`,
  });
  const s = await getSettings();
  if (s.categories[lead.category]?.auto_send && (await templateSaved(lead.category))) await queueEmail(leadId, "initial", "auto");
}

/** Save a found contact on a lead that is waiting for it. Keeps the one-lead-per-address rule. */
async function saveFound(
  leadId: string,
  c: {
    email: string | null;
    emailStatus: string | null;
    phone: string | null;
    linkedin: string | null;
    title: string | null;
    domain: string | null;
    name?: { full: string; first: string; last: string } | null;
  },
) {
  let email = c.email;
  if (email) {
    const taken = await one(`select id from leads where direct_email = $1 and id <> $2`, [email, leadId]);
    if (taken) email = null;
  }
  const ok = Boolean(email || c.phone);
  const upd = await q(
    `update leads set direct_email = $2, email_status = $3, direct_mobile = $4, linkedin_url = coalesce($5, linkedin_url),
       founder_title = coalesce(founder_title, $6), company_domain = coalesce(company_domain, $7),
       founder_full_name = coalesce(founder_full_name, $9), founder_first_name = coalesce(founder_first_name, $10),
       founder_last_name = coalesce(founder_last_name, $11),
       founder_source = coalesce(founder_source, case when $9::text is null then null else 'BetterContact Lead Finder' end),
       status = $8, updated_at = now()
     where id = $1 and status = 'enriching' returning id`,
    [leadId, email, c.emailStatus, c.phone, c.linkedin, c.title, c.domain, ok ? "enriched" : "enrichment_failed", c.name?.full ?? null, c.name?.first ?? null, c.name?.last ?? null],
  ).catch((e) => {
    if (String(e.code) === "23505")
      return q(`update leads set status = 'enrichment_failed', updated_at = now() where id = $1 and status = 'enriching' returning id`, [leadId]);
    throw e;
  });
  return { saved: upd.length > 0 && ok, email };
}

/** Apply a terminated Lead Finder result (owner-type people at the company's website). */
export async function applyLeadFinder(res: LfResult, via: "webhook" | "poll"): Promise<number> {
  const id = res.id ?? res.request_id;
  if (res.status !== "terminated" || !id) return 0;
  await noteCredits(res.credits_left);
  const lead = await one<LeadRow>(`select * from leads where bc_job_id = $1`, [`lf:${id}`]);
  if (!lead || lead.status !== "enriching") return 0;
  const people = (res.leads ?? []) as LfLead[];
  const rank = (x: LfLead) => (GOOD_EMAIL.has(String(x.contact_email_address_status)) ? 0 : x.contact_phone_number ? 1 : 2);
  const best = people.slice().sort((x, y) => rank(x) - rank(y))[0];
  const email = best && GOOD_EMAIL.has(String(best.contact_email_address_status)) ? best.contact_email_address!.trim().toLowerCase() : null;
  const full = best?.contact_full_name || [best?.contact_first_name, best?.contact_last_name].filter(Boolean).join(" ") || null;
  const { saved, email: savedEmail } = await saveFound(lead.id, {
    email,
    emailStatus: best?.contact_email_address_status ?? null,
    phone: best?.contact_phone_number?.trim() || null,
    linkedin: best?.contact_linkedin_profile_url ?? null,
    title: best?.contact_job_title ?? null,
    domain: best?.company_domain ?? null,
    name: full && best?.contact_first_name && best?.contact_last_name ? { full, first: best.contact_first_name, last: best.contact_last_name } : null,
  });
  await logRun(via === "webhook" ? "webhook" : "enrich", true, `Lead Finder ${via} for ${lead.company_name}: ${saved ? `${full ?? "owner"} found` : "no owner contact found"}`, {
    request_id: id,
    credits_left: res.credits_left,
  });
  if (!saved) return 0;
  await notify({
    title: `Contact found — ${lead.company_name}`,
    body: [full, savedEmail, best?.contact_phone_number].filter(Boolean).join(" · "),
    url: `/leads?lead=${lead.id}`,
    tag: `contact-${lead.id}`,
  });
  const s = await getSettings();
  if (savedEmail && s.categories[lead.category]?.auto_send && (await templateSaved(lead.category))) await queueEmail(lead.id, "initial", "auto");
  return 1;
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
      if (lead.email_status === "bounced") return { ok: false, reason: "Email bounced" };
      if (await t.query(`select 1 from suppressed_emails where email = $1`, [lead.direct_email.toLowerCase()]).then((r) => r.rows.length))
        return { ok: false, reason: "Already emailed (deleted lead)" };
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
  // Inbox placement guards (lib/deliverability.ts): paused after bounces, domain records, business hours, warm-up, human spacing.
  const paused = await sendPaused();
  if (paused) return `paused: ${paused.reason}`;
  const s0 = await getSettings();
  const dom = await currentCheck().catch(() => null);
  if (dom && !dom.ready) {
    await noteOnce("domain", `Sending held: ${dom.domain} is missing records that keep mail out of spam — see Settings → Mailbox`);
    return "held: sender domain records missing";
  }
  // Emails you send one at a time from a lead go out right away; bulk and automatic ones keep to business hours and spacing.
  const offHours = s0.us_business_hours && !inUsBusinessHours();
  const manualOnly = offHours || !(await nextSendAllowed());
  if (manualOnly && !(await one(`select 1 from email_log where status = 'queued' and origin = 'manual' limit 1`)))
    return offHours ? "outside US business hours — queued emails wait" : "waiting for the next send slot";
  if (!(await lease("send", 280))) return "already sending";
  try {
    const s = await getSettings();
    const warm = await warmupCap(s.daily_limit);
    await q(`update email_log set status = 'failed', error = 'Interrupted — check Sent folder before retrying' where status = 'sending' and created_at < now() - interval '15 minutes'`);
    let sent = 0;
    const t0 = Date.now();
    while (sent < max && Date.now() - t0 < 40_000) {
      const st = await one<{ today: number; last: string | null }>(
        `select count(*) filter (where sent_at > now() - interval '24 hours') as today, max(sent_at) as last from email_log where status = 'sent'`,
      );
      if ((st?.today ?? 0) >= warm.cap) {
        if (sent === 0)
          await noteOnce(
            "cap",
            warm.cap < s.daily_limit
              ? `Warm-up day ${warm.day}: ${warm.cap} emails today (new mailboxes ramp up to your limit of ${s.daily_limit} to stay out of spam) — the rest stay queued`
              : `Daily limit of ${s.daily_limit} reached — the rest stay queued`,
          );
        break;
      }
      if (!manualOnly && s.send_gap_min > 0 && st?.last && Date.now() - Date.parse(st.last) < s.send_gap_min * 60_000 - 5_000) break;
      const job = await one<{ id: string; lead_id: string; kind: EmailKind; recipient_email: string }>(
        `update email_log set status = 'sending' where id = (
           select id from email_log where status = 'queued' ${manualOnly ? "and origin = 'manual'" : ""}
           order by (origin = 'manual') desc, created_at limit 1 for update skip locked
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
        await q(`update email_log set status = 'sent', sent_at = now(), subject = $2, body = $3, message_id = $4 where id = $1`, [job.id, sealText(subject), sealText(body), r.messageId]);
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
        await scheduleNextSend(s.send_gap_min);
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

/**
 * Delete leads for good. The case is remembered so imports don't bring it back, and any address that already
 * received an email stays blocked — deleting never allows a second email. Test leads are simply removed.
 */
export async function deleteLeads(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return tx(async (t) => {
    await t.query(
      `insert into deleted_leads (external_case_id, company_name)
       select external_case_id, company_name from leads where id = any($1) and source <> 'test' and external_case_id is not null
       on conflict do nothing`,
      [ids],
    );
    await t.query(
      `insert into suppressed_emails (email, reason)
       select distinct e.recipient_email, 'emailed before the lead was deleted' from email_log e join leads l on l.id = e.lead_id
       where e.lead_id = any($1) and l.source <> 'test' and e.status in ('sent','sending','bounced')
       on conflict do nothing`,
      [ids],
    );
    const r = await t.query(`delete from leads where id = any($1) returning id`, [ids]);
    return r.rows.length;
  });
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
  await step("tax arrears", () => importCdtfa());
  await step("state tax lists", () => importStateTaxes());
  await step("apify liens", () => runApifyFeeds());
  await step("bank defaults", () => importSba(Math.max(5_000, 25_000 - (Date.now() - t0))));
  await step("research", () => findOwners(undefined, Math.max(5_000, 45_000 - (Date.now() - t0)), { batch: 8, concurrency: 4 }));
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
