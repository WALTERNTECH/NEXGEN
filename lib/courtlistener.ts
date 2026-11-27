import "server-only";
import { secret, type Category } from "./config";

const BASE = "https://www.courtlistener.com/api/rest/v4";

export interface ClDoc {
  description?: string;
  short_description?: string;
  snippet?: string;
  document_number?: string | number;
  entry_date_filed?: string;
  absolute_url?: string;
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
  absolute_url?: string;
  docket_absolute_url?: string;
  recap_documents?: ClDoc[];
}

async function clFetch(url: string) {
  const key = await secret("COURTLISTENER_API_KEY");
  if (!key) throw new Error("CourtListener API key is not set");
  const r = await fetch(url, {
    headers: { Authorization: `Token ${key}`, Accept: "application/json", "User-Agent": "nexgen-dashboard" },
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`CourtListener ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Newest dockets for one category, filed within the look-back window. */
export async function searchCategory(category: Category, query: string, lookbackDays: number, maxPages = 3): Promise<ClDocket[]> {
  const after = ymd(new Date(Date.now() - lookbackDays * 86_400_000));
  const params = new URLSearchParams({ type: "r", q: query, order_by: "dateFiled desc", filed_after: after });
  let url: string | null = `${BASE}/search/?${params}`;
  const out: ClDocket[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const j = (await clFetch(url)) as { results?: ClDocket[]; next?: string | null };
    for (const d of j.results ?? []) if (fitsCategory(category, d)) out.push(d);
    url = j.next ?? null;
  }
  return out;
}

export function isBankruptcyCourt(courtId = "") {
  return /b$/.test(courtId) || courtId.endsWith("bap");
}

function fitsCategory(category: Category, d: ClDocket) {
  if (!d.docket_id || !d.caseName) return false;
  const bk = isBankruptcyCourt(d.court_id);
  if (category === "court") return bk;
  // Tax and debt suits are civil cases in district courts.
  return !bk;
}

/** Documents in one docket that tend to name the person who signed for the company. */
export async function signerDocs(docketId: number): Promise<ClDoc[]> {
  const q = `docket_id:${docketId} AND (declaration OR petition OR "corporate ownership" OR resolution OR "statement of financial affairs" OR schedules OR summons OR complaint)`;
  const params = new URLSearchParams({ type: "rd", q, order_by: "entry_date_filed asc" });
  try {
    const j = (await clFetch(`${BASE}/search/?${params}`)) as { results?: ClDoc[] };
    return (j.results ?? []).slice(0, 20);
  } catch {
    return [];
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
