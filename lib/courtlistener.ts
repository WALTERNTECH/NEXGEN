import "server-only";
import { secret, type Category } from "./config";
import { q } from "./db";

const BASE = "https://www.courtlistener.com/api/rest/v4";

export interface ClDoc {
  description?: string;
  short_description?: string;
  snippet?: string;
  document_number?: string | number;
  entry_date_filed?: string;
  absolute_url?: string;
}

export interface ClEntry extends ClDoc {
  id?: number;
  is_available?: boolean;
  page_count?: number | null;
}

export interface ClDocket {
  docket_id: number;
  caseName: string;
  docketNumber?: string;
  court?: string;
  court_id?: string;
  dateFiled?: string;
  chapter?: string | number | null;
  suitNature?: string;
  cause?: string;
  party?: string[];
  attorney?: string[];
  firm?: string[];
  trustee_str?: string;
  assignedTo?: string;
  absolute_url?: string;
  docket_absolute_url?: string;
  recap_documents?: ClDoc[];
}

/** CourtListener throttles this account (search: 5 requests/minute). Every caller shares one budget kept in the database. */
export class RateLimited extends Error {
  constructor() {
    super("CourtListener rate limit — continuing next minute");
  }
}

const LIMITS = { search: 4, rest: 30 } as const;

async function takeBudget(bucket: keyof typeof LIMITS) {
  const r = await q<{ used: number }>(
    `insert into cl_budget (bucket, minute, used) values ($1, date_trunc('minute', now()), 1)
     on conflict (bucket) do update set
       used = case when cl_budget.minute = excluded.minute then cl_budget.used + 1 else 1 end,
       minute = excluded.minute
     returning used`,
    [bucket],
  );
  if ((r[0]?.used ?? 0) > LIMITS[bucket]) throw new RateLimited();
}

async function exhaust(bucket: keyof typeof LIMITS) {
  await q(`update cl_budget set used = 999, minute = date_trunc('minute', now()) where bucket = $1`, [bucket]).catch(() => {});
}

async function clFetch(url: string) {
  const key = await secret("COURTLISTENER_API_KEY");
  if (!key) throw new Error("CourtListener API key is not set");
  const bucket = url.includes("/search/") ? "search" : "rest";
  await takeBudget(bucket);
  const r = await fetch(url, {
    headers: { Authorization: `Token ${key}`, Accept: "application/json", "User-Agent": "nexgen-dashboard" },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  if (r.status === 429) {
    await exhaust(bucket);
    throw new RateLimited();
  }
  if (!r.ok) throw new Error(`CourtListener ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

export interface SearchPage {
  dockets: ClDocket[];
  next: string | null;
  count: number | null;
}

/**
 * One category's dockets between two dates. Pass `cursor` (the `next` URL from a previous page) to continue.
 * Incoming crawls use a short look-back; backfills pass an explicit date range.
 */
export async function searchCategory(
  category: Category,
  query: string,
  opts: { after: string; before?: string | null; cursor?: string | null; maxPages?: number },
): Promise<SearchPage> {
  const params = new URLSearchParams({ type: "r", q: query, order_by: "dateFiled desc", filed_after: opts.after });
  if (opts.before) params.set("filed_before", opts.before);
  let url: string | null = opts.cursor ?? `${BASE}/search/?${params}`;
  const out: ClDocket[] = [];
  let count: number | null = null;
  for (let page = 0; url && page < (opts.maxPages ?? 3); page++) {
    const j = (await clFetch(url)) as { results?: ClDocket[]; next?: string | null; count?: number };
    count ??= j.count ?? null;
    for (const d of j.results ?? []) if (fitsCategory(category, d)) out.push(d);
    url = j.next ?? null;
  }
  return { dockets: out, next: url, count };
}

export function isBankruptcyCourt(courtId = "") {
  return /b$/.test(courtId) || courtId.endsWith("bap");
}

function fitsCategory(category: Category, d: ClDocket) {
  if (!d.docket_id || !d.caseName) return false;
  const bk = isBankruptcyCourt(d.court_id);
  if (category === "court") return bk && !/\s(v\.?|vs\.?)\s/i.test(d.caseName);
  return !bk;
}

/** Every public docket entry (first page, oldest first) — used for signer names, case notes and documents to read. */
export async function docketEntries(docketId: number): Promise<ClEntry[]> {
  const params = new URLSearchParams({ type: "rd", q: `docket_id:${docketId}`, order_by: "entry_date_filed asc" });
  try {
    const j = (await clFetch(`${BASE}/search/?${params}`)) as { results?: ClEntry[] };
    return j.results ?? [];
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    return [];
  }
}

/** Plain text of a public RECAP document, when CourtListener has it. */
export async function documentText(id: number): Promise<string | null> {
  try {
    const j = (await clFetch(`${BASE}/recap-documents/${id}/?fields=plain_text,is_available`)) as { plain_text?: string };
    const t = (j.plain_text ?? "").trim();
    return t.length > 40 ? t : null;
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    return null;
  }
}


export function docketUrl(d: ClDocket) {
  const u = d.docket_absolute_url ?? d.absolute_url;
  return u ? `https://www.courtlistener.com${u}` : `https://www.courtlistener.com/docket/${d.docket_id}/`;
}

export async function ping(): Promise<string> {
  const j = (await clFetch(`${BASE}/search/?type=r&q=%22subchapter%20v%22&order_by=dateFiled%20desc`)) as { count?: number };
  return `connected (${j.count ?? 0} Subchapter V dockets indexed)`;
}
