import { after } from "next/server";
import { q, one } from "@/lib/db";
import { LEAD_COLS } from "@/lib/leads";
import { splitFullName } from "@/lib/extract";
import { queueEmail, processQueue, enrichPending, refreshDetails, type EmailKind } from "@/lib/pipeline";
import { getSettings, getTemplate, type Category } from "@/lib/config";
import { render } from "@/lib/render";
import { sendMail } from "@/lib/mailer";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

async function detail(id: string) {
  const lead = await one<{ category: Category; company_name: string } & Record<string, unknown>>(
    `select ${LEAD_COLS}, raw, case_summary, case_notes from leads where id = $1`,
    [id],
  );
  if (!lead) return null;
  const s = await getSettings();
  // Update B: the preview is this lead's own category template, filled in with its figures.
  const preview: Record<string, { subject: string; body: string; saved: boolean }> = {};
  for (const k of ["initial", "followup"] as const) {
    const t = await getTemplate(k, lead.category);
    preview[k] = { subject: render(t.subject, lead, s.sender_name), body: render(t.body, lead, s.sender_name), saved: t.saved };
  }
  const [emails, replies] = await Promise.all([
    q(`select id, kind, recipient_email, subject, body, status, origin, error, created_at, sent_at from email_log where lead_id = $1 order by created_at`, [id]),
    q(`select id, from_email, from_name, subject, body, received_at, is_read from replies where lead_id = $1 order by received_at`, [id]),
  ]);
  return { lead, emails, replies, preview, physical_address: s.physical_address };
}

export async function GET(_: Request, { params }: Ctx) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return bad("not found", 404);
  await q(`update leads set seen_at = coalesce(seen_at, now()) where id = $1`, [id]);
  const d = await detail(id);
  return d ? json(d) : bad("not found", 404);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const b = await body<{
    founder_full_name?: string;
    founder_title?: string;
    direct_email?: string;
    direct_mobile?: string;
    company_domain?: string;
    linkedin_url?: string;
    status?: string;
  }>(req);
  const lead = await one<{ status: string }>(`select status from leads where id = $1`, [id]);
  if (!lead) return bad("not found", 404);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (b.founder_full_name !== undefined) {
    const n = b.founder_full_name.trim().replace(/\s+/g, " ");
    const { first, last } = splitFullName(n);
    set("founder_full_name", n || null);
    set("founder_first_name", first || null);
    set("founder_last_name", last || null);
    set("founder_source", "entered by you");
  }
  if (b.founder_title !== undefined) set("founder_title", b.founder_title.trim() || null);
  if (b.company_domain !== undefined)
    set("company_domain", b.company_domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase() || null);
  if (b.linkedin_url !== undefined) set("linkedin_url", b.linkedin_url.trim() || null);
  if (b.direct_mobile !== undefined) set("direct_mobile", b.direct_mobile.trim() || null);
  if (b.direct_email !== undefined) {
    const e = b.direct_email.trim().toLowerCase();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return bad("That email address doesn't look right");
    set("direct_email", e || null);
    if (e) set("email_status", "entered");
  }
  if (b.status === "unsubscribed" || b.status === "replied" || b.status === "contacted") set("status", b.status);
  if (!sets.length) return bad("Nothing to change");
  try {
    await q(`update leads set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
  } catch (e) {
    if (String((e as { code?: string }).code) === "23505") return bad("Another lead already has that email address");
    throw e;
  }
  // A hand-entered email or phone makes the lead ready for outreach.
  await q(
    `update leads set status = 'enriched' where id = $1 and status in ('discovered','enrichment_failed','enriching')
       and (direct_email is not null or direct_mobile is not null)`,
    [id],
  );
  return json(await detail(id));
}

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const b = await body<{ action?: string; kind?: EmailKind; subject?: string; message?: string }>(req);
  if (b.action === "enrich") {
    const l = await one<{ founder_last_name: string | null }>(
      `update leads set status = 'discovered', bc_job_id = null where id = $1 and status in ('discovered','enrichment_failed','not_enriched_backfill','pending_details') returning founder_last_name`,
      [id],
    );
    if (!l) return bad("This lead is already enriched or being enriched");
    if (!l.founder_last_name) return bad("Add the owner's full name first");
    const r = await enrichPending(id);
    return /^sent/.test(r) ? json({ ok: true, result: r, ...(await detail(id)) }) : bad(r);
  }
  if (b.action === "details") {
    await refreshDetails(50_000, id);
    return json({ ok: true, ...(await detail(id)) });
  }
  if (b.action === "send") {
    if (b.kind !== "initial" && b.kind !== "followup") return bad("Choose which email to send");
    const r = await queueEmail(id, b.kind, "manual");
    if (!r.ok) return bad(r.reason!);
    after(() => processQueue().catch(() => {}));
    return json({ ok: true, ...(await detail(id)) });
  }
  if (b.action === "reply") {
    const message = (b.message ?? "").trim();
    if (!message) return bad("Write a message first");
    const lead = await one<{ direct_email: string | null; status: string }>(`select direct_email, status from leads where id = $1`, [id]);
    if (!lead?.direct_email) return bad("No email for this lead");
    if (lead.status === "unsubscribed") return bad("This lead unsubscribed");
    const last = await one<{ subject: string; message_id: string }>(
      `select subject, message_id from replies where lead_id = $1 order by received_at desc limit 1`,
      [id],
    );
    const subject =
      (b.subject ?? "").trim() || (last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : "Following up");
    try {
      const r = await sendMail({ to: lead.direct_email, subject, body: message, leadId: id, inReplyTo: last?.message_id });
      await q(
        `insert into email_log (lead_id, kind, recipient_email, subject, body, status, origin, message_id, sent_at)
         values ($1,'reply',$2,$3,$4,'sent','manual',$5,now())`,
        [id, lead.direct_email, subject, message, r.messageId],
      );
      await q(`update leads set last_email_at = now(), unread_replies = 0, updated_at = now() where id = $1`, [id]);
      await q(`update replies set is_read = true where lead_id = $1`, [id]);
      await logRun("send", true, `Reply sent to ${lead.direct_email}`);
    } catch (e) {
      return bad(`Sending failed: ${(e as Error).message}`);
    }
    return json({ ok: true, ...(await detail(id)) });
  }
  if (b.action === "read") {
    await q(`update replies set is_read = true where lead_id = $1`, [id]);
    await q(`update leads set unread_replies = 0 where id = $1`, [id]);
    return json({ ok: true });
  }
  return bad("Unknown action");
}
