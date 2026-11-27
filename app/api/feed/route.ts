import { after } from "next/server";
import { q, one } from "@/lib/db";
import { getSettings, getSetting, secretSource, mailbox } from "@/lib/config";
import { mailReady } from "@/lib/mailer";
import { tick } from "@/lib/pipeline";
import { json } from "../_util";
import { LEAD_COLS } from "@/lib/leads";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const [leads, stats, perDay, sentPerDay, s, lastTick, lastIngest, subs, queue, unread] = await Promise.all([
    q(`select ${LEAD_COLS} from leads order by created_at desc limit 600`),
    one(`select count(*) as total,
           count(*) filter (where created_at > now() - interval '7 days') as total_7d,
           count(*) filter (where direct_email is not null or direct_mobile is not null) as contacts,
           count(*) filter (where (direct_email is not null or direct_mobile is not null) and updated_at > now() - interval '7 days') as contacts_7d,
           count(*) filter (where seen_at is null) as unseen,
           count(*) filter (where status = 'replied') as replied,
           count(*) filter (where category = 'court') as court,
           count(*) filter (where category = 'tax') as tax,
           count(*) filter (where category = 'debt') as debt
         from leads`),
    q(`select to_char(d, 'YYYY-MM-DD') as day,
           (select count(*) from leads where created_at::date = d and category = 'court') as court,
           (select count(*) from leads where created_at::date = d and category = 'tax') as tax,
           (select count(*) from leads where created_at::date = d and category = 'debt') as debt
         from generate_series(current_date - 29, current_date, interval '1 day') as g(d) order by d`),
    q(`select to_char(d, 'YYYY-MM-DD') as day, (select count(*) from email_log where status = 'sent' and sent_at::date = d) as sent
         from generate_series(current_date - 29, current_date, interval '1 day') as g(d) order by d`),
    getSettings(),
    getSetting<string>("last_tick_at"),
    getSetting<string>("last_ingest_at"),
    one<{ n: number }>(`select count(*) as n from push_subs`),
    one<{ queued: number; sent: number; sent_24h: number; failed: number }>(
      `select count(*) filter (where status in ('queued','sending')) as queued, count(*) filter (where status = 'sent') as sent,
         count(*) filter (where status = 'sent' and sent_at > now() - interval '24 hours') as sent_24h,
         count(*) filter (where status = 'failed') as failed from email_log`,
    ),
    one<{ n: number }>(`select count(*) as n from replies where is_read = false`),
  ]);
  const mail = await mailReady();
  const health = {
    courtlistener: await secretSource("COURTLISTENER_API_KEY"),
    bettercontact: await secretSource("BETTERCONTACT_API_KEY"),
    openai: await secretSource("OPENAI_API_KEY"),
    mailbox: mail.ok ? mail.from : null,
    mailboxKind: (await mailbox()) ? "mailbox" : mail.via,
    pushDevices: subs?.n ?? 0,
  };
  // Keep the pipeline moving while the dashboard is open, even if the external cron is late.
  if (!lastTick || Date.now() - Date.parse(lastTick) > 75_000) after(() => tick().catch(() => {}));
  return json({
    now: new Date().toISOString(),
    leads,
    stats: { ...stats, ...queue, unread_replies: unread?.n ?? 0 },
    perDay,
    sentPerDay,
    settings: { auto_send: s.auto_send, send_gap_min: s.send_gap_min, daily_limit: s.daily_limit, ingest_every_min: s.ingest_every_min, categories: s.categories },
    lastTick,
    lastIngest,
    health,
  });
}
