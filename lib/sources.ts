import "server-only";
import { secret } from "./config";
import { looksLikePerson, splitFullName } from "./extract";

/**
 * Extra, cheaper sources for finding the company website, the owner and a verified email.
 *   Hunter.io  — email finder / domain search. Free 25 searches a month, paid from $49/month.
 *   Serper.dev — Google search results (website + owner mentions). 2,500 free searches, then ~$50 per 50,000.
 * Both are optional: each step is skipped when its key isn't set.
 */

export interface FoundEmail {
  email: string;
  first: string | null;
  last: string | null;
  title: string | null;
  source: string;
  domain: string | null;
}

const OWNERISH = /owner|founder|ceo|chief executive|president|managing (member|partner|director)|principal|proprietor|partner/i;

// ---------------- Hunter.io ----------------

async function hunter<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = await secret("HUNTER_API_KEY");
  if (!key) return null;
  const u = new URL(`https://api.hunter.io/v2/${path}`);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  u.searchParams.set("api_key", key);
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (r.status === 429 || r.status === 402) throw new Error("Hunter.io monthly limit reached");
    if (!r.ok) return null;
    return ((await r.json()) as { data: T }).data;
  } catch (e) {
    if (/limit/.test((e as Error).message)) throw e;
    return null;
  }
}

function hunterOk(status: string | undefined, score: number | undefined) {
  return status === "valid" || (status === "accept_all" && (score ?? 0) >= 90);
}

/** A named person at a company (domain or company name) → verified email. */
// Hunter is only ever asked about a website NEXGEN verified itself: given just a company name it can pick a different
// organisation with a similar name (a New Zealand firm, a city government), so the domain is required.
export async function hunterEmailFinder(first: string, last: string, domain: string): Promise<FoundEmail | null> {
  const d = await hunter<{ email?: string; score?: number; position?: string; domain?: string; verification?: { status?: string } }>("email-finder", {
    first_name: first,
    last_name: last,
    domain,
  });
  if (!d?.email || !hunterOk(d.verification?.status, d.score)) return null;
  return { email: d.email.toLowerCase(), first, last, title: d.position ?? null, source: "Hunter.io email finder", domain: d.domain ?? domain };
}

/** No name yet: the most senior people Hunter knows at the company, keeping an owner/executive with a verified address. */
export async function hunterDomainSearch(domain: string): Promise<FoundEmail | null> {
  const d = await hunter<{
    domain?: string;
    emails?: { value: string; first_name?: string; last_name?: string; position?: string; seniority?: string; confidence?: number; verification?: { status?: string } }[];
  }>("domain-search", { domain, type: "personal", seniority: "executive", limit: "10" });
  const list = d?.emails ?? [];
  const pick =
    list.find((e) => OWNERISH.test(e.position ?? "") && e.first_name && e.last_name && hunterOk(e.verification?.status, e.confidence)) ??
    list.find((e) => e.first_name && e.last_name && hunterOk(e.verification?.status, e.confidence));
  if (!pick) return null;
  return { email: pick.value.toLowerCase(), first: pick.first_name ?? null, last: pick.last_name ?? null, title: pick.position ?? null, source: "Hunter.io domain search", domain: d?.domain ?? domain };
}

// ---------------- Serper.dev (Google results) ----------------

interface SerperResult {
  knowledgeGraph?: { title?: string; website?: string; attributes?: Record<string, string> };
  organic?: { title: string; link: string; snippet?: string }[];
}

async function serper(q: string): Promise<SerperResult | null> {
  const key = await secret("SERPER_API_KEY");
  if (!key) return null;
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, gl: "us", num: 10 }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as SerperResult;
  } catch {
    return null;
  }
}

/** Directory and social sites are never "the company website". */
const NOT_COMPANY_SITE =
  /(linkedin|facebook|instagram|twitter|x\.com|yelp|bbb\.org|bizapedia|opencorporates|dnb\.com|zoominfo|manta|mapquest|yellowpages|courtlistener|pacer|justia|law360|bloomberg|crunchbase|indeed|glassdoor|google\.|wikipedia|tiktok|youtube|pinterest|nextdoor|chamberofcommerce|buzzfile|corporationwiki|sec\.gov|\.gov)\b/i;

function hostOf(link: string) {
  try {
    return new URL(link).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Candidate websites from Google: the knowledge panel first, then non-directory results carrying the company's words. Verified by the caller. */
export async function serperWebsites(company: string, place: string | null, distinctive: string[]): Promise<string[]> {
  const r = await serper(`"${company}"${place ? ` ${place}` : ""}`);
  if (!r) return [];
  const out: string[] = [];
  const kg = r.knowledgeGraph?.website ? hostOf(r.knowledgeGraph.website) : null;
  if (kg && !NOT_COMPANY_SITE.test(kg)) out.push(kg);
  for (const o of r.organic ?? []) {
    const h = hostOf(o.link);
    if (!h || NOT_COMPANY_SITE.test(h) || out.includes(h)) continue;
    const t = `${o.title} ${h}`.toLowerCase();
    if (distinctive.length && distinctive.every((w) => t.includes(w))) out.push(h);
  }
  return out.slice(0, 3);
}

/** "Jane Doe, Owner of Acme Plumbing" style mentions in Google results. */
export async function serperOwner(company: string, place: string | null): Promise<{ name: string; first: string; last: string; title: string } | null> {
  const r = await serper(`"${company}" (owner OR president OR founder OR CEO)${place ? ` ${place}` : ""}`);
  if (!r) return null;
  const NAME = "([A-Z][a-z'’\\-]+(?:\\s+[A-Z]\\.?)?\\s+[A-Z][a-z'’\\-]+)";
  const TITLE = "(Owner|Co-Owner|Founder|Co-Founder|CEO|President|Managing Member|Principal)";
  const res = [new RegExp(`${NAME},?\\s+(?:the\\s+)?${TITLE}`), new RegExp(`${TITLE}[:,]?\\s+${NAME}`)];
  const kgOwner = r.knowledgeGraph?.attributes && Object.entries(r.knowledgeGraph.attributes).find(([k]) => /owner|founder|ceo|president/i.test(k));
  const candidates: { name: string; title: string }[] = [];
  if (kgOwner) candidates.push({ name: kgOwner[1].split(/[,;(]/)[0].trim(), title: kgOwner[0] });
  const base = company.toLowerCase().split(/\s+/)[0];
  for (const o of r.organic ?? []) {
    const text = `${o.title}. ${o.snippet ?? ""}`;
    if (!text.toLowerCase().includes(base)) continue; // the mention has to be about this company
    for (const re of res) {
      const m = re.exec(text);
      if (!m) continue;
      const [name, title] = /^(Owner|Co-Owner|Founder|Co-Founder|CEO|President|Managing Member|Principal)$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
      candidates.push({ name, title });
    }
  }
  for (const c of candidates) {
    if (!looksLikePerson(c.name)) continue;
    const { first, last } = splitFullName(c.name);
    if (first && last) return { name: c.name, first, last, title: `${c.title} (web search)` };
  }
  return null;
}
