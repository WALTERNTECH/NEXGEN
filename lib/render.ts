// Template placeholders, shared by the sender and the in-app preview.
// Every email is filled in from its own lead at the moment it is sent — no two leads get the same text.

export interface RenderLead {
  company_name: string;
  category?: string | null;
  source?: string | null;
  founder_full_name?: string | null;
  founder_first_name?: string | null;
  founder_title?: string | null;
  debt_amount?: number | string | null;
  debt_amount_text?: string | null;
  tax_debt?: number | string | null;
  secured_debt?: number | string | null;
  unsecured_debt?: number | string | null;
  liabilities_range?: string | null;
  distress_type?: string | null;
  insolvency_stage?: string | null;
  filing_date?: string | null;
  case_number?: string | null;
  court_name?: string | null;
  creditor_summary?: string | null;
  judge?: string | null;
  trustee?: string | null;
  dba?: string | null;
  biz_city?: string | null;
  biz_state?: string | null;
  is_individual?: boolean | null;
}

/** What the builder shows: a plain-English label for each detail, and which categories it makes sense for. */
export const FIELDS: { key: string; label: string; cats?: string[] }[] = [
  { key: "first_name", label: "Owner first name" },
  { key: "full_name", label: "Owner full name" },
  { key: "owner_title", label: "Owner title" },
  { key: "company_name", label: "Company" },
  { key: "matter", label: "What happened (worded per lead)" },
  { key: "amount", label: "Amount owed" },
  { key: "owed_to", label: "Owed to" },
  { key: "filed_date", label: "Date filed" },
  { key: "days_in_distress", label: "Days since filed" },
  { key: "case_number", label: "Case number" },
  { key: "agency", label: "Court or agency" },
  { key: "location", label: "City, state" },
  { key: "exact_tax_debt", label: "Tax owed", cats: ["tax", "court"] },
  { key: "exact_total_debt", label: "Total debt", cats: ["court", "debt"] },
  { key: "secured_debt", label: "Secured debt", cats: ["court"] },
  { key: "unsecured_debt", label: "Unsecured debt", cats: ["court"] },
  { key: "insolvency_stage", label: "Stage" },
  { key: "distress_type", label: "Type of distress" },
  { key: "judge", label: "Judge", cats: ["court", "debt", "tax"] },
  { key: "trustee", label: "Trustee", cats: ["court"] },
  { key: "dba", label: "Trading as (d/b/a)" },
  { key: "sender_name", label: "Your name" },
];
export const PLACEHOLDERS = FIELDS.map((f) => f.key);

/** Used only when a placeholder sits outside [[ ]] and the lead doesn't have that detail. */
const FALLBACK: Record<string, string> = {
  first_name: "there",
  amount: "the balance on record",
  exact_total_debt: "the amount on file",
  debt_amount: "the amount on file",
  exact_tax_debt: "the amount on file",
  secured_debt: "—",
  unsecured_debt: "—",
  case_number: "on file",
  owed_to: "the creditor",
  matter: "the filing on record",
  days_in_distress: "several",
  distress_type: "court",
};

export function money(v: number | string | null | undefined) {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

const day = (date: string) => Date.parse(date.length === 10 ? date + "T12:00:00Z" : date);

export function daysSince(date: string | null | undefined) {
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.now() - day(date)) / 86_400_000));
}

export function longDate(date: string | null | undefined) {
  if (!date) return "";
  const t = day(String(date));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
}

const noParens = (s: string | null | undefined) => (s ?? "").replace(/\s*\(.*$/, "").trim();

/** One phrase that says exactly what happened to this lead, worded for where the lead came from. */
function matter(l: RenderLead): { matter: string; owedTo: string; agency: string } {
  const src = l.source ?? "courtlistener";
  const filed = longDate(l.filing_date);
  const on = filed ? ` on ${filed}` : "";
  const ref = l.case_number ? ` (case ${l.case_number})` : "";
  if (src === "courtlistener") {
    const court = l.court_name ? ` in the ${l.court_name}` : "";
    if (l.category === "tax") return { matter: `the federal tax suit the United States filed${court}${on}${ref}`, owedTo: "the IRS", agency: l.court_name ?? "" };
    if (l.category === "debt") {
      const by = l.creditor_summary ? ` ${l.creditor_summary}` : "";
      return { matter: `the collection suit${by} filed${court}${on}${ref}`, owedTo: l.creditor_summary || "the lender", agency: l.court_name ?? "" };
    }
    const kind = l.distress_type && /chapter|subchapter/i.test(l.distress_type) ? `${l.distress_type} petition` : "bankruptcy petition";
    return { matter: `the ${kind} filed${court}${on}${ref}`, owedTo: "your creditors", agency: l.court_name ?? "" };
  }
  const agency = noParens(l.creditor_summary || l.court_name);
  if (src === "cdtfa")
    return { matter: `the sales and use tax lien the ${agency} filed${on}, which puts the business on its Top 500 delinquent list`, owedTo: `the ${agency}`, agency };
  if (src.startsWith("tax_")) return { matter: `the past-due business tax balance on the ${agency}'s published delinquent-taxpayer list`, owedTo: `the ${agency}`, agency };
  if (src === "apify_fl_ftl") return { matter: `the federal tax lien the IRS recorded in Florida${on}`, owedTo: "the IRS", agency: "Internal Revenue Service" };
  if (src.startsWith("apify_ny")) return { matter: `the New York State tax warrant docketed${on}`, owedTo: "New York State", agency: "New York State Department of Taxation and Finance" };
  if (src === "sba") return { matter: `the SBA 7(a) loan from ${agency} that was charged off${on}`, owedTo: agency, agency };
  return { matter: `the ${(l.distress_type ?? "filing").toLowerCase()} on record${on}`, owedTo: agency, agency };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A registry sometimes lists the company itself as the contact ("Milk N Cookies" for Milk N Cookies LLC) — that's not a person to greet. */
function realOwner(l: RenderLead) {
  const full = l.founder_full_name?.trim();
  if (!full) return false;
  const n = norm(full);
  return !(n && norm(l.company_name).startsWith(n));
}

/** "YAMAHA MOTOR FINANCE CORPORATION USA" → "Yamaha Motor Finance Corporation USA" */
function tidy(s: string) {
  if (!s || s !== s.toUpperCase() || !/[A-Z]{4}/.test(s)) return s;
  return s.toLowerCase().replace(/\b([a-z])([a-z']*)/g, (w, a: string, b: string) =>
    /^(usa|us|llc|inc|na|n\.a|lp|llp|pc|ii|iii|irs|sba)$/.test(w) ? w.toUpperCase() : a.toUpperCase() + b,
  );
}

/** This lead's own values; "" when the lead doesn't have that detail. */
export function rawVars(l: RenderLead, senderName: string): Record<string, string> {
  if (l.creditor_summary) l = { ...l, creditor_summary: tidy(l.creditor_summary) };
  if (!realOwner(l)) l = { ...l, founder_full_name: null, founder_first_name: null, founder_title: null };
  const m = matter(l);
  const total = money(l.debt_amount) ?? l.liabilities_range ?? "";
  const tax = money(l.tax_debt) ?? "";
  const amount = (l.category === "tax" ? tax || money(l.debt_amount) : money(l.debt_amount) || tax) || "";
  return {
    first_name: l.founder_first_name || "",
    full_name: l.founder_full_name || "",
    owner_title: noParens(l.founder_title),
    company_name: l.company_name,
    matter: m.matter,
    amount,
    owed_to: m.owedTo,
    filed_date: longDate(l.filing_date),
    days_in_distress: l.filing_date ? String(daysSince(l.filing_date)) : "",
    case_number: l.case_number || "",
    agency: m.agency,
    location: [l.biz_city, l.biz_state].filter(Boolean).join(", "),
    exact_total_debt: total,
    debt_amount: total,
    exact_tax_debt: tax,
    secured_debt: money(l.secured_debt) ?? "",
    unsecured_debt: money(l.unsecured_debt) ?? "",
    insolvency_stage: l.insolvency_stage || "",
    distress_type: l.distress_type || "",
    court_name: l.court_name || "",
    judge: l.judge || "",
    trustee: l.trustee || "",
    dba: l.dba || "",
    sender_name: senderName || "",
  };
}

export function vars(l: RenderLead, senderName: string): Record<string, string> {
  const raw = rawVars(l, senderName);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v || FALLBACK[k] || "";
  return out;
}

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Fill a template for one lead.
 *  {{amount}}            → this lead's value (or a neutral fallback)
 *  [[ ... {{amount}} ]]  → that part is left out when this lead doesn't have the detail
 */
export function render(text: string, l: RenderLead, senderName: string) {
  const raw = rawVars(l, senderName);
  const full = vars(l, senderName);
  const fill = (t: string) => t.replace(TOKEN, (m, k) => (k in full ? full[k] : m));
  const out = text.replace(/\[\[([\s\S]*?)\]\]/g, (_, inner: string) => {
    const keys = [...inner.matchAll(TOKEN)].map((x) => x[1]);
    return keys.every((k) => raw[k]) ? fill(inner) : "";
  });
  return fill(out)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

/** Details a template uses outside [[ ]] that this lead is missing (shown before sending). */
export function missingFor(text: string, l: RenderLead, senderName: string): string[] {
  const raw = rawVars(l, senderName);
  const outside = text.replace(/\[\[[\s\S]*?\]\]/g, "");
  const miss = new Set<string>();
  for (const m of outside.matchAll(TOKEN)) if (m[1] in raw && !raw[m[1]]) miss.add(m[1]);
  return [...miss];
}
