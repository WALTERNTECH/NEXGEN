import { after } from "next/server";
import { q } from "@/lib/db";
import { queueEmail, processQueue, enrichPending, type EmailKind } from "@/lib/pipeline";
import { json, bad, body } from "../../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const b = await body<{ ids?: string[]; action?: string; kind?: EmailKind }>(req);
  const ids = (b.ids ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
  if (b.action === "seen") {
    if (ids.length) await q(`update leads set seen_at = coalesce(seen_at, now()) where id = any($1)`, [ids]);
    else await q(`update leads set seen_at = now() where seen_at is null`);
    return json({ ok: true });
  }
  if (b.action === "enrich") {
    await q(`update leads set status = 'discovered', bc_job_id = null where id = any($1) and status = 'enrichment_failed' and founder_last_name is not null`, [ids]);
    return json({ ok: true, result: await enrichPending() });
  }
  if (b.action === "send") {
    if (b.kind !== "initial" && b.kind !== "followup") return bad("Choose New-lead email or Follow-up email");
    if (!ids.length) return bad("Select at least one lead");
    let queued = 0;
    const skipped: Record<string, number> = {};
    for (const id of ids) {
      const r = await queueEmail(id, b.kind, "bulk");
      if (r.ok) queued++;
      else skipped[r.reason!] = (skipped[r.reason!] ?? 0) + 1;
    }
    if (queued) after(() => processQueue().catch(() => {}));
    return json({ ok: true, queued, skipped });
  }
  if (b.action === "cancel") {
    await q(`update email_log set status = 'cancelled', error = 'Cancelled from dashboard' where lead_id = any($1) and status = 'queued'`, [ids]);
    return json({ ok: true });
  }
  if (b.action === "delete") {
    await q(`delete from leads where id = any($1)`, [ids]);
    return json({ ok: true });
  }
  return bad("Unknown action");
}
