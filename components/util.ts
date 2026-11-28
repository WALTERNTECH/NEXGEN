export type Category = "court" | "tax" | "debt";

export interface Lead {
  id: string;
  category: Category;
  company_name: string;
  case_name: string;
  case_number: string | null;
  court_name: string | null;
  distress_type: string | null;
  debt_amount_text: string | null;
  debt_amount: number | null;
  creditor_summary: string | null;
  filing_date: string | null;
  insolvency_stage: string | null;
  founder_full_name: string | null;
  founder_first_name?: string | null;
  founder_last_name?: string | null;
  founder_title: string | null;
  founder_source: string | null;
  company_domain?: string | null;
  direct_email: string | null;
  email_status: string | null;
  direct_mobile: string | null;
  linkedin_url: string | null;
  status: string;
  auto_email_sent: boolean;
  contacted_at: string | null;
  last_email_at: string | null;
  followups_sent: number;
  replied_at: string | null;
  unread_replies: number;
  seen_at: string | null;
  cl_url: string | null;
  created_at: string;
  queued: string | null;
  is_historical_backfill: boolean;
  tax_debt: number | null;
  secured_debt: number | null;
  unsecured_debt: number | null;
  priority_debt: number | null;
  liabilities_range: string | null;
  figures_source: string | null;
  judge: string | null;
  trustee: string | null;
  dba: string | null;
  details_checked_at: string | null;
  owner_lookup_note?: string | null;
  source?: string | null;
  biz_city?: string | null;
  biz_state?: string | null;
  biz_address?: string | null;
  owner_lookup_at?: string | null;
  case_summary?: string | null;
  case_notes?: { date: string | null; no: string | null; text: string }[] | null;
}

export const CAT_LABEL: Record<Category, string> = { court: "Courts", tax: "Tax Debt", debt: "Commercial Debt" };
export const CAT_NAME: Record<Category, string> = {
  court: "Courts",
  tax: "Tax Debt",
  debt: "Commercial Debt Lawsuits",
};
export const CAT_COLOR: Record<Category, string> = { court: "var(--court)", tax: "var(--tax)", debt: "var(--debt)" };
export const CAT_HEX: Record<Category, string> = { court: "#2a78d6", tax: "#eb6834", debt: "#1baf7a" };
export const CATS: Category[] = ["court", "tax", "debt"];

export function daysSince(d: string | null) {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 86_400_000));
}

export function fmtDate(d: string | null, withYear = false) {
  if (!d) return "—";
  const dt = new Date(d.length === 10 ? d + "T12:00:00" : d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

export function ago(d: string | null) {
  if (!d) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(d)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtTime(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Digits for wa.me: US numbers without a country code get +1. */
export function waNumber(phone: string) {
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.slice(1);
  d = d.replace(/^00/, "");
  if (d.length === 10) return "1" + d;
  return d;
}

export function telHref(phone: string) {
  const d = phone.replace(/[^\d+]/g, "");
  return `tel:${d.startsWith("+") ? d : d.length === 10 ? "+1" + d : "+" + d}`;
}

export function prettyPhone(phone: string) {
  const d = phone.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return phone;
}

export function isNew(l: Lead) {
  return !l.seen_at && !l.is_historical_backfill;
}

export function usd(v: number | string | null | undefined) {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 });
}

export type Tone = "gray" | "green" | "amber" | "red" | "violet" | "blue";

/** The one outreach state a person needs to see at a glance. */
export function contactState(l: Lead): { label: string; tone: Tone } {
  if (l.status === "unsubscribed") return { label: "Unsubscribed", tone: "red" };
  if (l.status === "replied" || l.replied_at) return { label: l.unread_replies ? "Replied · unread" : "Replied", tone: "violet" };
  if (l.queued === "sending") return { label: "Sending…", tone: "amber" };
  if (l.queued) return { label: l.auto_email_sent ? "Follow-up queued" : "Email queued", tone: "amber" };
  if (l.auto_email_sent)
    return { label: l.followups_sent ? `Contacted · ${l.followups_sent} follow-up${l.followups_sent > 1 ? "s" : ""}` : "Contacted", tone: "green" };
  if (l.status === "enriching") return { label: "Finding contact…", tone: "blue" };
  if (l.status === "pending_details") return { label: "Reading case…", tone: "blue" };
  if (l.status === "not_enriched_backfill") return { label: "Backfill · not enriched", tone: "gray" };
  if (l.status === "enrichment_failed") return { label: l.founder_full_name ? "No contact found" : "Owner unknown", tone: "gray" };
  if (l.status === "discovered") return { label: "Finding contact…", tone: "blue" };
  return { label: "Not contacted", tone: "gray" };
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `Request failed (${r.status})`);
  return j as T;
}
