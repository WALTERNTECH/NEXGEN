import { q } from "@/lib/db";
import { json } from "../_util";

export const dynamic = "force-dynamic";

export async function GET() {
  const threads = await q(
    `select l.id as lead_id, l.company_name, l.founder_full_name, l.direct_email, l.direct_mobile, l.category, l.status,
            l.unread_replies, l.followups_sent, r.subject, r.body, r.received_at, r.from_email
     from leads l
     join lateral (select subject, body, received_at, from_email from replies where lead_id = l.id order by received_at desc limit 1) r on true
     order by r.received_at desc limit 300`,
  );
  return json({ threads });
}
