import "server-only";
import { q } from "./db";

export type RunKind = "ingest" | "enrich" | "webhook" | "send" | "inbox" | "system";

export async function logRun(kind: RunKind, ok: boolean, summary: string, detail?: unknown) {
  await q(`insert into runs (kind, ok, summary, detail) values ($1, $2, $3, $4)`, [
    kind,
    ok,
    summary.slice(0, 500),
    detail === undefined ? null : JSON.stringify(detail),
  ]).catch((e) => console.error("logRun", e));
}
