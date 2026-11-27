import { after } from "next/server";
import { getSetting, setSetting, CATEGORIES, type Category } from "@/lib/config";
import { startBackfill, processBackfill, type BackfillJob } from "@/lib/pipeline";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  return json({ job: await getSetting<BackfillJob>("backfill") });
}

/** Update A: date-range historical crawl. Rows are stored as not-enriched backfill; BetterContact is never called for them automatically. */
export async function POST(req: Request) {
  const b = await body<{ from?: string; to?: string; categories?: string[] }>(req);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!b.from || !b.to || !re.test(b.from) || !re.test(b.to)) return bad("Pick a start and end date");
  if (b.from > b.to) return bad("The start date must be before the end date");
  const cats = (b.categories ?? []).filter((c): c is Category => (CATEGORIES as string[]).includes(c));
  if (!cats.length) return bad("Pick at least one category");
  const cur = await getSetting<BackfillJob>("backfill");
  if (cur?.status === "running") return bad("A backfill is already running — cancel it first");
  const job = await startBackfill(b.from, b.to, cats);
  after(() => processBackfill(50_000).catch(() => {}));
  return json({ job });
}

export async function DELETE() {
  const cur = await getSetting<BackfillJob>("backfill");
  if (cur?.status === "running") {
    await setSetting("backfill", { ...cur, status: "cancelled", finished_at: new Date().toISOString() });
    await logRun("ingest", true, "Backfill cancelled");
  }
  return json({ ok: true });
}
