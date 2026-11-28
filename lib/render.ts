// Template placeholders, shared by the sender and the in-app preview.
// The system never reads or interprets your email text: it only finds {{placeholders}} and swaps in each lead's own values,
// at the moment that lead's email is sent — no two leads get the same text.

export interface RenderLead {
  company_name: string;
  category?: string | null;
  source?: string | null;
  founder_full_name?: string | null;
  founder_first_name?: string | null;
  founder_last_name?: string | null;
  founder_title?: string | null;
  direct_email?: string | null;
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
  biz_address?: string | null;
  is_individual?: boolean | null;
}

/**
 * Every detail NEXGEN can put into an email. `token` is what you type: {{token}}. `also` are other spellings that work too.
 * Matching ignores capitals, spaces and dashes: {{Company Name}}, {{company-name}} and {{COMPANY_NAME}} all mean {{company_name}}.
 */
export const FIELDS: { key: string; token: string; label: string; also: string[]; cats?: string[] }[] = [
  { key: "first_name", token: "first_name", label: "Owner first name", also: ["firstname", "first", "owner_first_name"] },
  { key: "last_name", token: "last_name", label: "Owner last name", also: ["lastname", "surname", "owner_last_name"] },
  { key: "full_name", token: "full_name", label: "Owner full name", also: ["name", "owner", "owner_name", "contact_name", "fullname"] },
  { key: "owner_title", token: "owner_title", label: "Owner title", also: ["title", "position", "role", "job_title"] },
  { key: "company_name", token: "company_name", label: "Company", also: ["company", "business", "business_name", "companyname", "firm"] },
  { key: "matter", token: "what_happened", label: "What happened (worded per lead)", also: ["matter", "situation", "filing", "event"] },
  { key: "amount", token: "amount_owed", label: "Amount owed", also: ["amount", "balance", "owed", "debt_owed", "amount_due", "balance_due"] },
  { key: "exact_total_debt", token: "total_debt", label: "Total debt", also: ["exact_total_debt", "debt", "debt_amount", "total", "total_amount", "liabilities"] },
  { key: "exact_tax_debt", token: "tax_debt", label: "Tax owed", also: ["exact_tax_debt", "tax", "tax_amount", "tax_owed", "taxes", "tax_balance"], cats: ["tax", "court"] },
  { key: "owed_to", token: "owed_to", label: "Owed to (agency or lender)", also: ["creditor", "lender", "bank", "plaintiff"] },
  { key: "filed_date", token: "filed_date", label: "Date filed", also: ["date_filed", "filing_date", "filed", "date", "filed_on"] },
  { key: "days_in_distress", token: "days_since_filed", label: "Days since filed", also: ["days_in_distress", "days", "days_ago"] },
  { key: "case_number", token: "case_number", label: "Case number", also: ["case", "case_no", "case_num", "docket", "docket_number", "reference"] },
  { key: "agency", token: "court_or_agency", label: "Court or agency", also: ["agency", "court", "court_name", "tax_agency"] },
  { key: "city", token: "city", label: "City", also: ["town"] },
  { key: "state", token: "state", label: "State", also: ["us_state"] },
  { key: "location", token: "location", label: "City, state", also: ["city_state", "where"] },
  { key: "address", token: "address", label: "Business address", also: ["business_address", "street"] },
  { key: "secured_debt", token: "secured_debt", label: "Secured debt", also: ["secured"], cats: ["court"] },
  { key: "unsecured_debt", token: "unsecured_debt", label: "Unsecured debt", also: ["unsecured"], cats: ["court"] },
  { key: "insolvency_stage", token: "stage", label: "Stage", also: ["insolvency_stage"] },
  { key: "distress_type", token: "distress_type", label: "Type of distress", also: ["type", "distress", "chapter"] },
  { key: "judge", token: "judge", label: "Judge", also: [], cats: ["court", "debt", "tax"] },
  { key: "trustee", token: "trustee", label: "Trustee", also: [], cats: ["court"] },
  { key: "dba", token: "trading_as", label: "Trading as (d/b/a)", also: ["dba", "d_b_a", "doing_business_as"] },
  { key: "email", token: "email", label: "Their email address", also: ["lead_email", "owner_email"] },
  { key: "sender_name", token: "your_name", label: "Your name", also: ["sender_name", "sender", "my_name", "signature_name"] },
];
export const PLACEHOLDERS = FIELDS.map((f) => f.token);

const keyNorm = (k: string) =>
  k
    .toLowerCase()
    .trim()
    .replace(/[\s\-./]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
const ALIAS = new Map<string, string>();
for (const f of FIELDS) for (const n of [f.key, f.token, ...f.also]) ALIAS.set(keyNorm(n), f.key);

/** "{{ Company Name }}" → "company_name"; null when NEXGEN doesn't know the detail. */
export function resolveKey(raw: string): string | null {
  return ALIAS.get(keyNorm(raw)) ?? null;
}

/** {{anything}} — and {single} braces too, but only when the word inside is a known detail. */
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}|\{\s*([A-Za-z][A-Za-z0-9 _.\-]{0,40}?)\s*\}/g;
function tokens(t: string) {
  return [...t.matchAll(TOKEN)].map((m) => ({ text: m[0], double: m[1] !== undefined, key: resolveKey(m[1] ?? m[2] ?? "") }));
}

/** Placeholders in a template that NEXGEN can't fill (shown in the builder; Save refuses them). */
export function unknownTokens(t: string): string[] {
  return [...new Set(tokens(t).filter((x) => x.double && !x.key).map((x) => x.text))];
}

/** Used only when a placeholder sits outside [[ ]] and the lead doesn't have that detail. */
const FALLBACK: Record<string, string> = {
  first_name: "there",
  amount: "the balance on record",
  exact_total_debt: "the amount on file",
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
  return Math.max(0, Math.round((Date.now() - day(date)) / 86_400_000));
}

export function longDate(date: string | null | undefined) {
  if (!date) return "";
  const t = day(String(date));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
}

const noParens = (s: string | null | undefined) => (s ?? "").replace(/\s*\(.*$/, "").trim();

/** One phrase that says exactly what happened to this lead, worded for where the lead came from. */
function matter(l: RenderLead): { matter: string; owedTo: string; agency: string } {
  // A test lead reads like a state tax-list lead.
  const src = l.source === "test" ? "tax_test" : (l.source ?? "courtlistener");
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

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A registry sometimes lists the company itself as the contact ("Milk N Cookies" for Milk N Cookies LLC) — that's not a person to greet. */
function realOwner(l: RenderLead) {
  const full = l.founder_full_name?.trim();
  if (!full) return false;
  const n = plain(full);
  return !(n && plain(l.company_name).startsWith(n));
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
  if (!realOwner(l)) l = { ...l, founder_full_name: null, founder_first_name: null, founder_last_name: null, founder_title: null };
  const m = matter(l);
  const total = money(l.debt_amount) ?? l.liabilities_range ?? "";
  const tax = money(l.tax_debt) ?? "";
  const amount = (l.category === "tax" ? tax || money(l.debt_amount) : money(l.debt_amount) || tax) || "";
  return {
    first_name: l.founder_first_name || "",
    last_name: l.founder_last_name || "",
    full_name: l.founder_full_name || "",
    owner_title: noParens(l.founder_title),
    company_name: l.company_name,
    matter: m.matter,
    amount,
    exact_total_debt: total,
    exact_tax_debt: tax,
    owed_to: m.owedTo,
    filed_date: longDate(l.filing_date),
    days_in_distress: l.filing_date ? String(daysSince(l.filing_date)) : "",
    case_number: l.case_number || "",
    agency: m.agency,
    city: l.biz_city || "",
    state: l.biz_state || "",
    location: [l.biz_city, l.biz_state].filter(Boolean).join(", "),
    address: l.biz_address || "",
    secured_debt: money(l.secured_debt) ?? "",
    unsecured_debt: money(l.unsecured_debt) ?? "",
    insolvency_stage: l.insolvency_stage || "",
    distress_type: l.distress_type || "",
    judge: l.judge || "",
    trustee: l.trustee || "",
    dba: l.dba || "",
    email: l.direct_email || "",
    sender_name: senderName || "",
  };
}

export function vars(l: RenderLead, senderName: string): Record<string, string> {
  const raw = rawVars(l, senderName);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v || FALLBACK[k] || "";
  return out;
}

/**
 * Fill a template for one lead.
 *  {{company_name}}              → this lead's value (or a neutral fallback if it has none)
 *  [[ ... {{total_debt}} ... ]]  → that part is left out when this lead doesn't have the detail
 * Anything that isn't a placeholder is left exactly as you wrote it.
 */
export function render(text: string, l: RenderLead, senderName: string) {
  const raw = rawVars(l, senderName);
  const full = vars(l, senderName);
  const fill = (t: string) =>
    t.replace(TOKEN, (m: string, a?: string, b?: string) => {
      const k = resolveKey(a ?? b ?? "");
      return k && k in full ? full[k] : m;
    });
  const out = text.replace(/\[\[([\s\S]*?)\]\]/g, (_: string, inner: string) => (tokens(inner).every((x) => !x.key || raw[x.key]) ? fill(inner) : ""));
  return fill(out)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

/** Details a template uses outside [[ ]] that this lead is missing (shown before sending). */
export function missingFor(text: string, l: RenderLead, senderName: string): string[] {
  const raw = rawVars(l, senderName);
  const outside = text.replace(/\[\[[\s\S]*?\]\]/g, "");
  return [...new Set(tokens(outside).filter((x) => x.key && !raw[x.key]).map((x) => x.key!))];
}
