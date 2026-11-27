// Template placeholders, shared by the sender and the in-app preview.

export interface RenderLead {
  company_name: string;
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
  judge?: string | null;
  trustee?: string | null;
  dba?: string | null;
}

export const PLACEHOLDERS = [
  "first_name",
  "full_name",
  "company_name",
  "exact_total_debt",
  "exact_tax_debt",
  "secured_debt",
  "unsecured_debt",
  "case_number",
  "insolvency_stage",
  "distress_type",
  "days_in_distress",
  "court_name",
  "judge",
  "sender_name",
] as const;

export function money(v: number | string | null | undefined) {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function daysSince(date: string | null | undefined) {
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.now() - Date.parse(date.length === 10 ? date + "T12:00:00Z" : date)) / 86_400_000));
}

export function vars(l: RenderLead, senderName: string): Record<string, string> {
  const total = money(l.debt_amount) ?? l.liabilities_range ?? "the amount on file";
  return {
    first_name: l.founder_first_name || "there",
    full_name: l.founder_full_name || "",
    company_name: l.company_name,
    exact_total_debt: total,
    debt_amount: total,
    exact_tax_debt: money(l.tax_debt) ?? "the amount on file",
    secured_debt: money(l.secured_debt) ?? "—",
    unsecured_debt: money(l.unsecured_debt) ?? "—",
    case_number: l.case_number || "on file",
    insolvency_stage: l.insolvency_stage || "",
    distress_type: l.distress_type || "court",
    days_in_distress: String(daysSince(l.filing_date)),
    court_name: l.court_name || "",
    judge: l.judge || "",
    trustee: l.trustee || "",
    dba: l.dba || "",
    sender_name: senderName || "",
  };
}

export function render(text: string, l: RenderLead, senderName: string) {
  const v = vars(l, senderName);
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in v ? v[k] : m));
}
