import { q, one } from "@/lib/db";
import { json } from "../_util";
import { openRows } from "@/lib/privacy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  const [runs, emails, dup] = await Promise.all([
    q(
      `select id, kind, ok, summary, created_at from runs ${kind && kind !== "all" ? "where kind = $1" : ""} order by created_at desc limit 300`,
      kind && kind !== "all" ? [kind] : [],
    ),
    q(
      `select e.id, e.kind, e.recipient_email, e.subject, e.status, e.origin, e.error, e.created_at, e.sent_at, l.company_name, l.id as lead_id
       from email_log e join leads l on l.id = e.lead_id order by e.created_at desc limit 300`,
    ),
    one<{ addresses: number; initial_sent: number; dupes: number }>(
      `select count(distinct recipient_email) filter (where kind = 'initial' and status = 'sent') as addresses,
              count(*) filter (where kind = 'initial' and status = 'sent') as initial_sent,
              (select count(*) from (select recipient_email from email_log where kind = 'initial' and status = 'sent'
                 group by recipient_email having count(*) > 1) d) as dupes
       from email_log`,
    ),
  ]);
  return json({ runs, emails: openRows(emails), dedupe: dup });
}
