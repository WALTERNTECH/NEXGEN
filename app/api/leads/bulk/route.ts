import { after } from "next/server";
import { q } from "@/lib/db";
import { queueEmail, processQueue, enrichPending, deleteLeads, type EmailKind } from "@/lib/pipeline";
import { getSettings, getTemplate, type Category } from "@/lib/config";
import { render, missingFor } from "@/lib/render";
import type { LeadVars } from "@/lib/mailer";
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
    // Explicit Enrich now on selected rows (also the only way backfill rows reach BetterContact).
    const rows = await q<{ id: string }>(
      `update leads set status = 'discovered', bc_job_id = null
       where id = any($1) and status in ('enrichment_failed','not_enriched_backfill')
         and founder_last_name is not null and founder_last_name <> ''
       returning id`,
      [ids],
    );
    if (!rows.length) return bad("None of the selected leads has an owner name to search for");
    return json({ ok: true, result: await enrichPending(rows.map((r) => r.id)) });
  }
  if (b.action === "preview") {
    // Exactly what each selected lead will receive: its own category's template, filled in from its own record.
    if (b.kind !== "initial" && b.kind !== "followup") return bad("Choose New-lead email or Follow-up email");
    const s = await getSettings();
    const leads = await q<LeadVars & { category: Category; direct_email: string | null; status: string; auto_email_sent: boolean }>(
      `select * from leads where id = any($1) order by company_name`,
      [ids],
    );
    const tpl: Partial<Record<Category, { subject: string; body: string }>> = {};
    const emails = [];
    for (const l of leads) {
      if (!l.direct_email || l.status === "unsubscribed" || (b.kind === "initial" ? l.auto_email_sent : !l.auto_email_sent)) continue;
      const t = (tpl[l.category] ??= await getTemplate(b.kind, l.category));
      emails.push({
        id: l.id,
        company: l.company_name,
        category: l.category,
        to: l.direct_email,
        subject: render(t.subject, l, s.sender_name),
        body: render(t.body, l, s.sender_name),
        missing: [...new Set([...missingFor(t.subject, l, s.sender_name), ...missingFor(t.body, l, s.sender_name)])].filter((k) => k !== "sender_name"),
      });
    }
    return json({ emails, physical_address: s.physical_address });
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
    return json({ ok: true, deleted: await deleteLeads(ids) });
  }
  return bad("Unknown action");
}
