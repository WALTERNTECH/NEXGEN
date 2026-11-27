import "server-only";
import { getSetting, setSetting, getSettings, type Category } from "./config";
import { q, lease, release } from "./db";
import { isBusiness, looksLikePerson, splitFullName } from "./extract";
import { money } from "./render";
import { logRun } from "./runs";
import { notify } from "./push";

/**
 * Distress signals that never reach a federal court:
 *   Tax  — California CDTFA "Top 500" sales & use tax delinquencies (businesses with tax liens, exact balance, lien date).
 *   Debt — SBA 7(a) loan records: bank loans the lender charged off because the business stopped paying (nationwide).
 * Every imported company goes into the same research queue (owner → website → email) as court leads.
 */

const CDTFA_URL = "https://cdtfa.ca.gov/data/deliq.dat";
const CDTFA_PAGE = "https://www.cdtfa.ca.gov/taxes-and-fees/top500.htm";
const SBA_PAGE = "https://data.sba.gov/dataset/7a-504-foia";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; nexgen-import)" };

interface Row {
  key: string;
  category: Category;
  source: "cdtfa" | "sba";
  company: string;
  dba: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  amount: number;
  date: string | null; // lien date / charge-off date
  creditor: string;
  distress: string;
  stage: string;
  caseName: string;
  url: string;
  raw: Record<string, unknown>;
}

function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s.trim();
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bLlc\b/g, "LLC")
    .replace(/\bInc\b/g, "Inc")
    .replace(/\bDba\b/g, "DBA")
    .trim();
}

function isoDate(s: string | undefined) {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Insert new companies (or refresh the amount for known ones). Returns how many were new. */
async function save(rows: Row[], minIndividual: number): Promise<number> {
  let added = 0;
  for (const r of rows) {
    const individual = !isBusiness(r.company) && looksLikePerson(r.company);
    if (individual && r.amount < minIndividual) continue;
    const person = individual ? splitFullName(r.company) : null;
    const res = await q<{ inserted: boolean }>(
      `insert into leads (external_case_id, category, case_name, court_name, company_name, dba, distress_type, debt_amount, debt_amount_text,
         tax_debt, creditor_summary, filing_date, insolvency_stage, status, cl_url, raw, source, biz_state, biz_city, biz_address,
         is_individual, founder_full_name, founder_first_name, founder_last_name, founder_title, founder_source, figures_source, details_checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'researching',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
       on conflict (external_case_id) do update set debt_amount = excluded.debt_amount, debt_amount_text = excluded.debt_amount_text,
         tax_debt = coalesce(excluded.tax_debt, leads.tax_debt), updated_at = now()
       returning (xmax = 0) as inserted`,
      [
        r.key,
        r.category,
        r.caseName,
        r.creditor,
        titleCase(r.company),
        r.dba ? titleCase(r.dba) : null,
        r.distress,
        r.amount,
        money(r.amount),
        r.category === "tax" ? r.amount : null,
        r.creditor,
        r.date,
        r.stage,
        r.url,
        JSON.stringify(r.raw),
        r.source,
        r.state,
        r.city ? titleCase(r.city) : null,
        r.address,
        individual,
        individual ? titleCase(r.company) : null,
        person?.first ?? null,
        person?.last ?? null,
        individual ? "Owner (individual)" : null,
        individual ? (r.source === "cdtfa" ? "CDTFA list" : "SBA loan record") : null,
        r.source === "cdtfa" ? "CDTFA Top 500 sales & use tax delinquencies" : "SBA 7(a) loan record (gross charge-off)",
      ],
    );
    if (res[0]?.inserted) added++;
  }
  return added;
}

// ---------------- Tax arrears: California CDTFA Top 500 ----------------

export async function importCdtfa(force = false): Promise<string> {
  const s = await getSettings();
  if (!s.source_cdtfa) return "off";
  const last = await getSetting<string>("cdtfa_imported_at");
  if (!force && last && Date.now() - Date.parse(last) < 24 * 3600_000) return "not due";
  if (!(await lease("import_cdtfa", 120))) return "already running";
  try {
  const r = await fetch(CDTFA_URL, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!r.ok) throw new Error(`CDTFA list ${r.status}`);
  const text = await r.text();
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.split("\t").map((x) => x.replace(/^"|"$/g, "").replace(/""/g, '"').trim());
    if (f.length < 9 || !f[0]) continue;
    // name, dba, street, city, state, zip, balance, paid, lien date, partners…
    const amount = Number(f[6]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const partners = f.slice(9).filter(Boolean);
    rows.push({
      key: `cdtfa:${f[0].toUpperCase()}|${f[5].slice(0, 5)}`,
      category: "tax",
      source: "cdtfa",
      company: f[0],
      dba: f[1] || null,
      address: [f[2], f[3], f[4], f[5]].filter(Boolean).join(", "),
      city: f[3] || null,
      state: f[4] || "CA",
      amount,
      date: isoDate(f[8]),
      creditor: "California Department of Tax and Fee Administration (sales & use tax)",
      distress: "State sales & use tax lien",
      stage: "Tax lien filed — on CDTFA Top 500 list",
      caseName: `CDTFA Top 500 delinquent sales & use taxpayers — ${f[0]}`,
      url: CDTFA_PAGE,
      raw: { partners, paid: f[7] || null },
    });
  }
  const added = await save(rows, s.individual_min_amount);
  await setSetting("cdtfa_imported_at", new Date().toISOString());
  await setSetting("cdtfa_status", { rows: rows.length, added, at: new Date().toISOString() });
  await logRun("ingest", true, `Tax arrears (CDTFA Top 500): ${rows.length} businesses on the list, ${added} new — queued for owner & email search`);
  if (added) await notify({ title: `${added} businesses with unpaid tax`, body: "From California's Top 500 list — searching for their owners' emails", url: "/leads?cat=tax", tag: "cdtfa" });
  return `${rows.length} listed, ${added} new`;
  } finally {
    await release("import_cdtfa");
  }
}

// ---------------- Bank-loan defaults: SBA 7(a) charge-offs ----------------

function parseCsvLine(l: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (quoted) {
      if (ch === '"') {
        if (l[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface SbaJob {
  url: string;
  offset: number;
  size: number;
  carry: string;
  header: string[] | null;
  scanned: number;
  matched: number;
  added: number;
  status: "running" | "done";
  started_at: string;
  finished_at?: string;
}

async function latestSbaUrl(): Promise<string | null> {
  const r = await fetch(SBA_PAGE, { headers: UA, signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!r.ok) return null;
  const html = await r.text();
  const m = /https:\/\/data\.sba\.gov\/sites\/default\/files\/uploaded_resources\/FOIA_7a_FY2020_Present_asof_\d+\.csv/.exec(html);
  return m ? m[0] : null;
}

const CHUNK = 12 * 1024 * 1024;

/** One ~12 MB slice per call. Starts over when SBA publishes a new quarterly file. */
export async function importSba(budgetMs = 30_000): Promise<string> {
  const s = await getSettings();
  if (!s.source_sba) return "off";
  if (!(await lease("import_sba", 120))) return "already running";
  try {
  let job = await getSetting<SbaJob>("sba_import");
  if (!job || job.status === "done") {
    const lastCheck = await getSetting<string>("sba_checked_at");
    if (job && lastCheck && Date.now() - Date.parse(lastCheck) < 24 * 3600_000) return "up to date";
    await setSetting("sba_checked_at", new Date().toISOString());
    const url = await latestSbaUrl();
    if (!url) return "SBA file not found";
    if (job && job.url === url) return "up to date";
    job = { url, offset: 0, size: 0, carry: "", header: null, scanned: 0, matched: 0, added: 0, status: "running", started_at: new Date().toISOString() };
    await logRun("ingest", true, `Bank-loan defaults: reading SBA 7(a) loan file ${url.split("/").pop()}`);
  }
  const cutoff = new Date(Date.now() - s.sba_months * 30.44 * 86_400_000).toISOString().slice(0, 10);
  const t0 = Date.now();
  while (job.status === "running" && Date.now() - t0 < budgetMs) {
    const end = job.offset + CHUNK - 1;
    const r = await fetch(job.url, { headers: { ...UA, Range: `bytes=${job.offset}-${end}` }, signal: AbortSignal.timeout(45_000), cache: "no-store" });
    if (r.status !== 206 && r.status !== 200) throw new Error(`SBA file ${r.status}`);
    const total = Number(/\/(\d+)$/.exec(r.headers.get("content-range") ?? "")?.[1] ?? 0);
    if (total) job.size = total;
    const text = job.carry + (await r.text());
    const lines = text.split(/\r?\n/);
    job.carry = lines.pop() ?? "";
    const rows: Row[] = [];
    for (const line of lines) {
      if (!line) continue;
      const f = parseCsvLine(line);
      if (!job.header) {
        job.header = f;
        continue;
      }
      job.scanned++;
      const h = job.header;
      const v = (name: string) => f[h.indexOf(name)] ?? "";
      if (v("LoanStatus").trim() !== "CHGOFF") continue;
      const date = v("ChargeOffDate").slice(0, 10);
      const amount = Number(v("GrossChargeOffAmount"));
      if (!date || date < cutoff || !(amount >= 5000)) continue;
      job.matched++;
      const bank = v("BankName").trim();
      rows.push({
        key: `sba:${v("LocationID")}:${v("ApprovalDate")}`,
        category: "debt",
        source: "sba",
        company: v("BorrName").trim(),
        dba: null,
        address: [v("BorrStreet"), v("BorrCity"), v("BorrState"), v("BorrZip")].filter(Boolean).join(", "),
        city: v("BorrCity") || null,
        state: v("BorrState") || null,
        amount,
        date,
        creditor: `${bank} (SBA 7(a) loan, $${Number(v("GrossApproval")).toLocaleString("en-US")} approved ${v("ApprovalDate")})`,
        distress: "Bank loan charged off (SBA 7(a))",
        stage: "Loan charged off — unpaid",
        caseName: `SBA 7(a) loan from ${bank} charged off ${date}`,
        url: SBA_PAGE,
        raw: { bank, naics: v("NaicsDescription").trim(), businessType: v("BusinessType"), approved: v("GrossApproval"), approvalDate: v("ApprovalDate") },
      });
    }
    job.added += await save(rows, s.individual_min_amount);
    job.offset = end + 1;
    if (r.status === 200 || (job.size && job.offset >= job.size)) {
      job.status = "done";
      job.finished_at = new Date().toISOString();
      await logRun("ingest", true, `Bank-loan defaults (SBA 7(a)): ${job.scanned.toLocaleString()} loans read, ${job.matched} charged off in the last ${s.sba_months} months over $5,000, ${job.added} new companies queued for email search`);
      if (job.added) await notify({ title: `${job.added} businesses with defaulted bank loans`, body: "From SBA 7(a) charge-offs — searching for their owners' emails", url: "/leads?cat=debt", tag: "sba" });
    }
    await setSetting("sba_import", job);
  }
  return job.status === "done" ? `done (${job.added} new)` : `reading ${Math.round((job.offset / Math.max(1, job.size)) * 100)}% (${job.added} new so far)`;
  } finally {
    await release("import_sba");
  }
}
