import "server-only";
import { secret } from "./config";
import { looksLikePerson, splitFullName } from "./extract";
import { serperOwner, serperWebsites } from "./sources";

/**
 * Owner finder: court filings for brand-new cases rarely name the owner, and BetterContact needs a person.
 * We look the company up in free state business registries (and OpenCorporates when a key is set),
 * and separately try to find the company's website so BetterContact's Lead Finder can search by domain.
 */

export interface OwnerHit {
  name: string;
  first: string;
  last: string;
  title: string;
  source: string;
}

const SUFFIX = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|co|company|ltd|limited|l\.?p|l\.?l\.?p|p\.?l\.?l\.?c|p\.?c|pllc)\b\.?/gi;

/** "B & H Management, LLC" → "B & H MANAGEMENT" (for matching across registries). */
export function baseName(company: string) {
  return company
    .toUpperCase()
    .replace(/\bD\/?B\/?A\b.*$/, "")
    .replace(SUFFIX, " ")
    .replace(/[.,'’"()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameCompany(a: string, b: string) {
  return baseName(a) === baseName(b);
}

function soqlLiteral(s: string) {
  return s.replace(/'/g, "''");
}

function person(name: string | null | undefined, title: string, source: string): OwnerHit | null {
  if (!name) return null;
  const clean = name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
  if (!looksLikePerson(clean)) return null;
  const { first, last } = splitFullName(clean);
  if (!first || !last) return null;
  return { name: clean, first, last, title, source };
}

async function socrata<T>(url: string, params: Record<string, string>): Promise<T[]> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  try {
    const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (!r.ok) return [];
    return (await r.json()) as T[];
  } catch {
    return [];
  }
}

// ---- New York: Department of State, active corporations (chairman / service-of-process contact) ----
async function newYork(company: string): Promise<OwnerHit | null> {
  const rows = await socrata<{ current_entity_name: string; chairman_name?: string; dos_process_name?: string }>(
    "https://data.ny.gov/resource/n9v6-gdp6.json",
    { $where: `upper(current_entity_name) like '${soqlLiteral(baseName(company))}%'`, $limit: "10" },
  );
  const r = rows.find((x) => sameCompany(x.current_entity_name, company));
  if (!r) return null;
  return person(r.chairman_name, "Chairman / CEO (NY Dept. of State)", "New York business registry") ?? person(r.dos_process_name, "Registered contact (NY Dept. of State)", "New York business registry");
}

// ---- Colorado: Secretary of State business entities (registered agent) ----
async function colorado(company: string): Promise<OwnerHit | null> {
  const rows = await socrata<{ entityname: string; agentfirstname?: string; agentmiddlename?: string; agentlastname?: string }>(
    "https://data.colorado.gov/resource/4ykn-tg5h.json",
    { $where: `upper(entityname) like '${soqlLiteral(baseName(company))}%'`, $limit: "10" },
  );
  const r = rows.find((x) => sameCompany(x.entityname, company));
  if (!r || !r.agentlastname) return null;
  return person(`${r.agentfirstname ?? ""} ${r.agentlastname}`, "Registered agent (Colorado SOS)", "Colorado business registry");
}

// ---- Connecticut: business master → principals ----
async function connecticut(company: string): Promise<OwnerHit | null> {
  const biz = await socrata<{ id?: string; accountnumber?: string; name: string }>("https://data.ct.gov/resource/n7gp-d28j.json", {
    $where: `upper(name) like '${soqlLiteral(baseName(company))}%'`,
    $limit: "10",
  });
  const b = biz.find((x) => sameCompany(x.name, company));
  const id = b?.id ?? b?.accountnumber;
  if (!id) return null;
  const ps = await socrata<{ firstname?: string; lastname?: string; designation?: string; type?: string }>("https://data.ct.gov/resource/ka36-64k6.json", {
    business_id: id,
    $limit: "10",
  });
  const rank = (d = "") => (/president|ceo|owner|managing|member|manager|principal/i.test(d) ? 0 : 1);
  ps.sort((a, b) => rank(a.designation) - rank(b.designation));
  for (const p of ps) {
    const hit = person(`${p.firstname ?? ""} ${p.lastname ?? ""}`, `${p.designation || "Principal"} (Connecticut registry)`, "Connecticut business registry");
    if (hit) return hit;
  }
  return null;
}

// ---- Oregon: active businesses, associated names (president, member, manager…) ----
async function oregon(company: string): Promise<OwnerHit | null> {
  const rows = await socrata<{ business_name: string; associated_name_type?: string; first_name?: string; last_name?: string }>(
    "https://data.oregon.gov/resource/tckn-sxa6.json",
    { $where: `upper(business_name) like '${soqlLiteral(baseName(company))}%'`, $limit: "30" },
  );
  const mine = rows.filter((x) => sameCompany(x.business_name, company) && x.last_name);
  const rank = (t = "") => (/president|member|manager|owner|ceo|secretary/i.test(t) ? 0 : /registered agent/i.test(t) ? 1 : 2);
  mine.sort((a, b) => rank(a.associated_name_type) - rank(b.associated_name_type));
  for (const r of mine) {
    const hit = person(`${r.first_name ?? ""} ${r.last_name}`, `${r.associated_name_type ?? "Officer"} (Oregon SOS)`.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()), "Oregon business registry");
    if (hit) return hit;
  }
  return null;
}

// ---- OpenCorporates (paid for commercial use): officers in any state ----
async function openCorporates(company: string, state: string | null): Promise<OwnerHit | null> {
  const token = await secret("OPENCORPORATES_API_KEY");
  if (!token) return null;
  const params = new URLSearchParams({ q: company, api_token: token, per_page: "10", inactive: "false" });
  if (state) params.set("jurisdiction_code", `us_${state}`);
  try {
    const r = await fetch(`https://api.opencorporates.com/v0.4/companies/search?${params}`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { results?: { companies?: { company: { name: string; jurisdiction_code: string; company_number: string } }[] } };
    const c = j.results?.companies?.map((x) => x.company).find((x) => sameCompany(x.name, company));
    if (!c) return null;
    const d = await fetch(`https://api.opencorporates.com/v0.4/companies/${c.jurisdiction_code}/${encodeURIComponent(c.company_number)}?api_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!d.ok) return null;
    const dj = (await d.json()) as { results?: { company?: { officers?: { officer: { name: string; position?: string; end_date?: string | null } }[] } } };
    const officers = (dj.results?.company?.officers ?? []).map((o) => o.officer).filter((o) => !o.end_date);
    const rank = (p = "") => (/president|ceo|chief executive|owner|managing member|manager|member|director/i.test(p) ? 0 : /agent/i.test(p) ? 2 : 1);
    officers.sort((a, b) => rank(a.position) - rank(b.position));
    for (const o of officers) {
      const hit = person(o.name, `${o.position ?? "Officer"} (OpenCorporates)`, "OpenCorporates");
      if (hit) return hit;
    }
  } catch {}
  return null;
}

/** Two-letter state of a federal court id: "nyeb" → "ny", "flmb" → "fl". */
export function courtState(courtId: string | null | undefined) {
  const s = (courtId ?? "").slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : null;
}

export async function findOwner(company: string, courtId: string | null): Promise<{ hit: OwnerHit | null; tried: string[] }> {
  const state = courtState(courtId);
  const tried: string[] = [];
  const byState: Record<string, (c: string) => Promise<OwnerHit | null>> = { ny: newYork, co: colorado, ct: connecticut, or: oregon };
  if (state && byState[state]) {
    tried.push(`${state.toUpperCase()} registry`);
    const h = await byState[state](company);
    if (h) return { hit: h, tried };
  }
  // Many small companies are registered in New York even when they file elsewhere nearby.
  if (state && ["nj", "ct", "pa"].includes(state)) {
    tried.push("NY registry");
    const h = await newYork(company);
    if (h) return { hit: h, tried };
  }
  if (await secret("OPENCORPORATES_API_KEY")) {
    tried.push("OpenCorporates");
    const h = await openCorporates(company, state);
    if (h) return { hit: h, tried };
  }
  if (await secret("SERPER_API_KEY")) {
    tried.push("web search");
    const w = await serperOwner(company, state ? (STATES[state] ?? null) : null);
    if (w) return { hit: { ...w, source: "web search (Google)" }, tried };
  }
  return { hit: null, tried };
}

// ---- Company website (free): try the obvious .com names and keep one whose page is about this company ----

const PARKED = /domain (?:is )?for sale|buy this domain|parked free|godaddy\.com\/domainsearch|this domain may be for sale|sedo|hugedomains|dan\.com/i;

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
  dc: "district of columbia", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon",
  pa: "pennsylvania", pr: "puerto rico", ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  gu: "guam", vi: "virgin islands",
};

/** The site must mention the company's state (name, or "XX 12345" address form), so a same-name business elsewhere isn't picked. */
function mentionsState(html: string, state: string | null) {
  if (!state) return false;
  const name = STATES[state];
  if (name && html.includes(name)) return true;
  return new RegExp(`[\\s,]${state}\\.?\\s+\\d{5}\\b`, "i").test(html);
}

function mentionsOtherState(html: string, state: string | null) {
  for (const [code, name] of Object.entries(STATES)) {
    if (code === state) continue;
    if (new RegExp(`\\b${name}\\b`).test(html)) return true;
  }
  return false;
}

function norm(s: string) {
  return s
    .toLowerCase()
    .replace(/&amp;|&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function findWebsite(company: string, courtId: string | null = null): Promise<string | null> {
  const state = courtState(courtId);
  const base = baseName(company)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  const words = base.split(" ").filter(Boolean);
  if (!words.length) return null;
  const distinctive = words.filter((w) => w.length >= 4 && !/^(and|the|group|services|service|management|holdings|enterprises|company|international|development|solutions)$/.test(w));
  if (!distinctive.length) return null;
  const cands = new Set<string>([
    words.join(""),
    words.filter((w) => w !== "and" && w !== "the").join(""),
    words.slice(0, 2).join(""),
    words.join("-"),
  ]);
  /** Accept a site only if its page is clearly this company: same name + same state, or the exact name as title and no other state. */
  const verify = async (host: string): Promise<string | null> => {
    if (!acceptableHost(host)) return null;
    try {
      const r = await fetch(`https://${host}`, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; nexgen-site-check)" } });
      if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) return null;
      const finalHost = new URL(r.url).hostname.replace(/^www\./, "");
      if (!acceptableHost(finalHost)) return null;
      const raw = (await r.text()).slice(0, 1_500_000).toLowerCase();
      if (PARKED.test(raw)) return null;
      const title = norm(/<title[^>]*>([^<]*)/.exec(raw)?.[1] ?? "");
      const html = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
      const hits = distinctive.filter((w) => html.includes(w)).length;
      if (hits >= Math.min(2, distinctive.length) && mentionsState(html, state)) return finalHost;
      const titleName = norm(title.split(/\s[|–—-]\s|\s::\s/)[0] ?? "").replace(/\b(home|welcome|official site|inc|llc|corp|ltd)\b/g, "").replace(/\s+/g, " ").trim();
      if (titleName === norm(base) && words.length >= 2 && !mentionsOtherState(html, state)) return finalHost;
    } catch {}
    return null;
  };
  for (const c of [...cands].filter((x) => x.length >= 5).slice(0, 4)) {
    const ok = await verify(`${c}.com`);
    if (ok) return ok;
  }
  // Google (Serper): candidates go through the same page check.
  for (const h of await serperWebsites(company, state ? (STATES[state] ?? null) : null, distinctive)) {
    const ok = await verify(h);
    if (ok) return ok;
  }
  return null;
}

/** US business sites only: no government, school, military, or foreign country domains. */
function acceptableHost(host: string) {
  const h = host.toLowerCase();
  if (/\.(gov|edu|mil|int)$/.test(h)) return false;
  const tld = h.split(".").pop() ?? "";
  if (tld.length === 2 && tld !== "us" && tld !== "co" && tld !== "io") return false; // .nz, .uk, .ca …
  if (/\.(co|com|org|net)\.[a-z]{2}$/.test(h)) return false; // .co.nz, .com.au …
  return true;
}
