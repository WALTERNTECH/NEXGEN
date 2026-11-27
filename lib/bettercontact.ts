import "server-only";
import { secret } from "./config";

const BASE = "https://app.bettercontact.rocks/api/v2";

export interface BcLeadIn {
  leadId: string;
  firstName: string;
  lastName: string;
  company: string;
  companyDomain?: string | null;
  linkedinUrl?: string | null;
}

export interface BcItem {
  enriched?: boolean;
  custom_fields?: { name: string; value: string }[] | Record<string, string>;
  contact_email_address?: string | null;
  contact_email_address_status?: string | null;
  contact_phone_number?: string | null;
  contact_linkedin_profile_url?: string | null;
  contact_job_title?: string | null;
  company_domain?: string | null;
}

export interface BcResult {
  id?: string;
  request_id?: string;
  status?: string;
  credits_left?: number;
  data?: BcItem[];
}

async function key() {
  const k = await secret("BETTERCONTACT_API_KEY");
  if (!k) throw new Error("BetterContact API key is not set");
  return k;
}

/** Start an async enrichment. Returns the request id. Falls back to email-only when the phone add-on is missing. */
export async function enrich(leads: BcLeadIn[], webhook: string | null): Promise<string> {
  const k = await key();
  const body = (phone: boolean) =>
    JSON.stringify({
      data: leads.map((l) => ({
        first_name: l.firstName,
        last_name: l.lastName,
        ...(l.companyDomain ? { company_domain: l.companyDomain } : { company: l.company }),
        ...(l.linkedinUrl ? { linkedin_url: l.linkedinUrl } : {}),
        custom_fields: { lead_id: l.leadId },
      })),
      enrich_email_address: true,
      enrich_phone_number: phone,
      ...(webhook ? { webhook } : {}),
    });
  const post = (phone: boolean) =>
    fetch(`${BASE}/async`, {
      method: "POST",
      headers: { "X-API-Key": k, "Content-Type": "application/json" },
      body: body(phone),
      signal: AbortSignal.timeout(20_000),
    });
  let r = await post(true);
  if (r.status === 402) {
    const msg = await r.text();
    if (/phone|plan|add-?on|feature/i.test(msg)) r = await post(false);
    else throw new Error(`BetterContact: out of credits (${msg.slice(0, 120)})`);
  }
  if (!r.ok) throw new Error(`BetterContact ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { id?: string; request_id?: string };
  const id = j.id ?? j.request_id;
  if (!id) throw new Error("BetterContact returned no request id");
  return id;
}

export async function result(requestId: string): Promise<BcResult> {
  const r = await fetch(`${BASE}/async/${encodeURIComponent(requestId)}`, {
    headers: { "X-API-Key": await key() },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 406) return { id: requestId, status: "unknown" };
  if (!r.ok && r.status !== 202) throw new Error(`BetterContact ${r.status}`);
  return r.json();
}

export async function account(): Promise<{ credits_left?: number; email?: string }> {
  const r = await fetch(`${BASE}/account`, { headers: { "X-API-Key": await key() }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`BetterContact ${r.status}`);
  return r.json();
}

export function leadIdOf(item: BcItem): string | null {
  const cf = item.custom_fields;
  if (!cf) return null;
  if (Array.isArray(cf)) return cf.find((c) => c.name === "lead_id")?.value ?? null;
  return cf.lead_id ?? null;
}

export const GOOD_EMAIL = new Set(["deliverable", "valid", "catch_all_safe"]);
