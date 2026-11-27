import "server-only";
import { getSetting, setSetting, getSettings, secret } from "./config";
import { lease, release } from "./db";
import { isBusiness, looksLikePerson } from "./extract";
import { saveRows, type ImportRow } from "./importers";
import { logRun } from "./runs";
import { notify } from "./push";

/**
 * Paid tax-lien feeds on Apify (pay per record). Runs are started once a day per feed, polled on later ticks,
 * and the results go into the same owner → website → email research as every other lead.
 * Spend is capped: the daily budget is split across enabled feeds and turned into a record limit per run.
 */
export const APIFY_FEEDS = {
  fl_ftl: {
    label: "Florida — new IRS federal tax liens",
    actor: "jobito~florida-lien-daily-feed",
    pricePerRecord: 0.003,
    page: "https://apify.com/jobito/florida-lien-daily-feed",
    input: (max: number) => ({ lookbackDays: 30, onlyNew: true, maxRecords: max }),
  },
  ny_llc: {
    label: "New York State — tax warrants on LLCs",
    actor: "j0401~us-liens",
    pricePerRecord: 0.012,
    page: "https://apify.com/j0401/us-liens",
    input: (max: number, since: string) => ({ mode: "rows", corpus: "ny", debtor: "LLC", dateFrom: since, maxResults: max }),
  },
  ny_inc: {
    label: "New York State — tax warrants on corporations",
    actor: "j0401~us-liens",
    pricePerRecord: 0.012,
    page: "https://apify.com/j0401/us-liens",
    input: (max: number, since: string) => ({ mode: "rows", corpus: "ny", debtor: "INC", dateFrom: since, maxResults: max }),
  },
} as const;
export type ApifyFeed = keyof typeof APIFY_FEEDS;
export const APIFY_FEED_CODES = Object.keys(APIFY_FEEDS) as ApifyFeed[];

interface FeedState {
  pendingSince?: string | null;
  runId?: string | null;
  lastRunId?: string | null;
  datasetId?: string | null;
  startedAt?: string | null;
  lastSuccessAt?: string | null;
  lastSince?: string | null;
  lastRecords?: number;
  lastAdded?: number;
  lastCostUsd?: number | null;
  error?: string | null;
}

const API = "https://api.apify.com/v2";

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await secret("APIFY_API_TOKEN");
  if (!token) throw new Error("Apify token not set");
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  if (r.status === 401) throw new Error("Apify rejected the token");
  if (r.status === 402) throw new Error("Apify account is out of credit");
  if (!r.ok) throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()) as T;
}

/** The last run's status and the tail of its log, for diagnosing a feed. */
export async function apifyLastRun(feed: ApifyFeed): Promise<{ status: string; message: string; log: string }> {
  const st = ((await getSetting<Partial<Record<ApifyFeed, FeedState>>>("apify_state")) ?? {})[feed];
  const id = st?.runId ?? st?.lastRunId;
  if (!id) return { status: "none", message: "No run yet", log: "" };
  const run = await apify<{ data: { status: string; statusMessage?: string } }>(`/actor-runs/${id}`);
  const token = await secret("APIFY_API_TOKEN");
  const log = await fetch(`${API}/actor-runs/${id}/log`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).then((r) => (r.ok ? r.text() : ""));
  return { status: run.data.status, message: run.data.statusMessage ?? "", log: log.split("\n").slice(-40).join("\n") };
}

/** Diagnostic: run an actor synchronously with a hard cap of 5 records (a few cents) and return what it delivers. */
export async function apifyProbe(actor: string, input: Record<string, unknown>): Promise<{ items: unknown[]; log: string }> {
  const token = await secret("APIFY_API_TOKEN");
  const capped = actor.startsWith("jobito") ? { ...input, maxRecords: 5 } : { ...input, maxResults: 5 };
  const run = await apify<{ data: { id: string; defaultDatasetId: string } }>(
    `/acts/${actor}/runs?memory=1024&timeout=240&waitForFinish=240&maxItems=5&maxTotalChargeUsd=0.10`,
    { method: "POST", body: JSON.stringify(capped) },
  );
  const items = await apify<unknown[]>(`/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json&limit=5`);
  const log = await fetch(`${API}/actor-runs/${run.data.id}/log`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }).then((r) => (r.ok ? r.text() : ""));
  return { items, log: log.split("\n").filter((l) => /INFO|WARN|ERROR/.test(l)).slice(-8).join("\n") };
}

/** Clear a feed's daily marker so it runs again on the next tick. */
export async function rerunApifyFeed(feed: ApifyFeed) {
  const all = (await getSetting<Partial<Record<ApifyFeed, FeedState>>>("apify_state")) ?? {};
  all[feed] = { ...all[feed], lastSuccessAt: null, error: null, runId: null };
  await setSetting("apify_state", all);
}

export async function apifyAccount(): Promise<string> {
  const me = await apify<{ data: { username?: string; plan?: { id?: string } } }>("/users/me");
  return `connected as ${me.data.username ?? "?"}${me.data.plan?.id ? ` (${me.data.plan.id} plan)` : ""}`;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// ---- Map feed records to leads ----

interface FlFiling {
  document_number?: string;
  filing_date?: string;
  assessment_date?: string;
  debtors?: { name?: string; address_1?: string; address_2?: string; city?: string; state?: string; zip_code?: string }[];
}

interface UsLien {
  corpus?: string;
  lienType?: string;
  filingType?: string;
  filingNumber?: string;
  filingDate?: string;
  debtorName?: string;
  debtorNames?: string[];
  amount?: number | string | null;
  address?: string;
  city?: string;
  stateCode?: string;
  zip?: string;
  sourceUrl?: string;
}

function isoDay(s: string | undefined | null) {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const u = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return u ? `${u[3]}-${u[1].padStart(2, "0")}-${u[2].padStart(2, "0")}` : null;
}

/** "JOSE G LEON RAMIREZ INDIVIDUALLY AND AS A RESPONSIBLE PERSON OF TACOS & CHELAS LLC", "LESKI INC. TRADING AS HAT TRIX BAR AND GRILL" */
export function parseNyDebtor(raw: string): { company: string; dba: string | null; owner: string | null } {
  let t = raw.replace(/\s+/g, " ").trim();
  let owner: string | null = null;
  const rp = /^(.+?)\s+INDIVIDUALLY AND AS (?:A |THE )?(?:RESPONSIBLE PERSON|OFFICER|PRESIDENT|MEMBER|OWNER)S? (?:OF|FOR) (.+)$/i.exec(t);
  if (rp) {
    owner = rp[1].trim();
    t = rp[2].trim();
  }
  const ta = /^(.+?)\s+(?:TRADING AS|T\/A|D\/B\/A|DBA)\s+(.+)$/i.exec(t);
  return ta ? { company: ta[1].trim(), dba: ta[2].trim(), owner } : { company: t, dba: null, owner };
}

function toRows(feed: ApifyFeed, items: unknown[], minAmount = 0): ImportRow[] {
  const f = APIFY_FEEDS[feed];
  const rows: ImportRow[] = [];
  const base = (name: string, ref: string, date: string | null, amount: number, address: string | null, city: string | null, state: string | null, url: string): ImportRow => ({
    key: `apify_${feed}:${ref}:${name.toUpperCase()}`,
    category: "tax",
    source: `apify_${feed}`,
    company: name,
    dba: null,
    address,
    city,
    state,
    amount,
    date,
    creditor: "Internal Revenue Service (federal tax lien)",
    distress: `Federal tax lien — ${f.label.split(" —")[0]}`,
    stage: "IRS federal tax lien filed",
    caseName: `${f.label}: ${name} (filing ${ref})`,
    url,
    raw: { feed, ref },
    figuresSource: amount ? `${f.label} (Apify)` : undefined,
  });
  if (feed === "fl_ftl") {
    for (const it of items as FlFiling[]) {
      for (const d of it.debtors ?? []) {
        if (!d.name) continue;
        rows.push(
          base(
            d.name,
            it.document_number ?? "",
            isoDay(it.filing_date),
            0,
            [d.address_1, d.address_2, d.city, d.state, d.zip_code].filter(Boolean).join(", "),
            d.city ?? null,
            d.state ?? "FL",
            "https://dos.fl.gov/sunbiz/search/",
          ),
        );
      }
    }
  } else if (feed === "ny_llc" || feed === "ny_inc") {
    // One company can have several warrants: add them up.
    const byCompany = new Map<string, ImportRow>();
    for (const it of items as UsLien[]) {
      if (!it.debtorName) continue;
      const d = parseNyDebtor(it.debtorName);
      const amount = Number(String(it.amount ?? "").replace(/[$,]/g, "")) || 0;
      const key = `${d.company.toUpperCase()}|${(it.zip ?? "").slice(0, 5)}`;
      const cur = byCompany.get(key);
      if (cur) {
        cur.amount = Math.round((cur.amount + amount) * 100) / 100;
        if (!cur.owner && d.owner) cur.owner = { name: d.owner, title: "Responsible person (NY tax warrant)" };
        continue;
      }
      const row = base(d.company, it.filingNumber ?? "", isoDay(it.filingDate), amount, [it.city, it.stateCode, it.zip?.slice(0, 5)].filter(Boolean).join(", ") || null, it.city ?? null, it.stateCode ?? null, it.sourceUrl ?? f.page);
      row.key = `apify_ny:${key}`;
      row.dba = d.dba;
      row.creditor = "New York State Department of Taxation and Finance";
      row.distress = "New York State tax warrant";
      row.stage = "State tax warrant docketed";
      row.owner = d.owner ? { name: d.owner, title: "Responsible person (NY tax warrant)" } : null;
      byCompany.set(key, row);
    }
    rows.push(...[...byCompany.values()].filter((r) => r.amount >= minAmount));
  } else {
    for (const it of items as UsLien[]) {
      const names = it.debtorNames?.length ? it.debtorNames : it.debtorName ? [it.debtorName] : [];
      const amount = Number(String(it.amount ?? "").replace(/[$,]/g, "")) || 0;
      for (const n of names.slice(0, 3)) {
        rows.push(
          base(n, it.filingNumber ?? "", isoDay(it.filingDate), amount, [it.address, it.city, it.stateCode, it.zip].filter(Boolean).join(", ") || null, it.city ?? null, it.stateCode ?? null, it.sourceUrl ?? f.page),
        );
      }
    }
  }
  // Companies always; people only when an amount at or above the individual minimum is shown (handled in saveRows).
  return rows.filter((r) => isBusiness(r.company) || looksLikePerson(r.company));
}

// ---- Scheduler: one feed action per call ----

export async function runApifyFeeds(): Promise<string> {
  const s = await getSettings();
  const LEGACY: Record<string, string[]> = { co_irs: ["ny_llc"], or_irs: ["ny_inc"], nyc_ftl: [] };
  const wanted = new Set(s.apify_feeds.flatMap((c) => LEGACY[c] ?? [c]));
  const enabled = APIFY_FEED_CODES.filter((c) => wanted.has(c));
  if (!enabled.length || !(await secret("APIFY_API_TOKEN"))) return "off";
  if (!(await lease("apify", 120))) return "busy";
  const all = (await getSetting<Partial<Record<ApifyFeed, FeedState>>>("apify_state")) ?? {};
  try {
    // 1) Collect a finished run first.
    const running = enabled.find((c) => all[c]?.runId);
    if (running) {
      const st = all[running]!;
      const run = await apify<{ data: { status: string; defaultDatasetId: string; usageTotalUsd?: number } }>(`/actor-runs/${st.runId}`);
      const status = run.data.status;
      if (status === "READY" || status === "RUNNING") {
        if (Date.now() - Date.parse(st.startedAt ?? new Date().toISOString()) < 50 * 60_000) return `${running}: running`;
        await apify(`/actor-runs/${st.runId}/abort`, { method: "POST" }).catch(() => {});
      }
      if (status === "SUCCEEDED") {
        const items = await apify<unknown[]>(`/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json&limit=5000`);
        const rows = toRows(running, items, s.tax_min_amount);
        const added = await saveRows(rows, s.individual_min_amount);
        all[running] = { ...st, runId: null, datasetId: null, lastRunId: st.runId, lastSince: st.pendingSince ?? st.lastSince, lastSuccessAt: new Date().toISOString(), lastRecords: items.length, lastAdded: added, lastCostUsd: run.data.usageTotalUsd ?? null, error: null };
        await setSetting("apify_state", all);
        await logRun(
          "ingest",
          true,
          `Apify — ${APIFY_FEEDS[running].label}: ${items.length} records${run.data.usageTotalUsd != null ? ` ($${run.data.usageTotalUsd.toFixed(2)})` : ""}, ${added} new companies queued for email search`,
        );
        if (added) await notify({ title: `${added} new federal tax liens`, body: `${APIFY_FEEDS[running].label} — searching for owners' emails`, url: "/leads?cat=tax", tag: `apify-${running}` });
        return `${running}: ${items.length} records, ${added} new`;
      }
      all[running] = { ...st, runId: null, datasetId: null, lastRunId: st.runId, error: `run ${status.toLowerCase()}` };
      await setSetting("apify_state", all);
      await logRun("ingest", false, `Apify — ${APIFY_FEEDS[running].label}: run ${status.toLowerCase()}`);
      return `${running}: ${status}`;
    }
    // 2) Otherwise start the next feed that hasn't run today.
    const due = enabled.find((c) => !all[c]?.lastSuccessAt || Date.now() - Date.parse(all[c]!.lastSuccessAt!) > 22 * 3600_000);
    if (!due) return "up to date";
    const lastErrAt = all[due]?.startedAt;
    if (all[due]?.error && lastErrAt && Date.now() - Date.parse(lastErrAt) < 3 * 3600_000) return `${due}: waiting after error`;
    const f = APIFY_FEEDS[due];
    const share = s.apify_daily_budget / enabled.length;
    const max = Math.max(5, Math.floor(share / f.pricePerRecord));
    const since = all[due]?.lastSince ?? day(new Date(Date.now() - 30 * 86_400_000));
    const run = await apify<{ data: { id: string; defaultDatasetId: string } }>(`/acts/${f.actor}/runs?memory=1024&timeout=1800&maxItems=${max}&maxTotalChargeUsd=${Math.max(0.05, share).toFixed(2)}`, {
      method: "POST",
      body: JSON.stringify(f.input(max, since)),
    });
    all[due] = { ...all[due], runId: run.data.id, datasetId: run.data.defaultDatasetId, startedAt: new Date().toISOString(), pendingSince: day(new Date(Date.now() - 2 * 86_400_000)), error: null };
    await setSetting("apify_state", all);
    return `${due}: started (up to ${max} records, about $${(max * f.pricePerRecord).toFixed(2)})`;
  } catch (e) {
    const msg = (e as Error).message;
    const code = enabled.find((c) => all[c]?.runId) ?? enabled[0];
    all[code] = { ...all[code], runId: null, error: msg, startedAt: new Date().toISOString() };
    await setSetting("apify_state", all);
    await logRun("ingest", false, `Apify: ${msg}`);
    return msg;
  } finally {
    await release("apify");
  }
}
