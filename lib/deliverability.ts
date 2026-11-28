import "server-only";
import { resolveTxt, resolveMx } from "node:dns/promises";
import { q, one } from "./db";
import { getSetting, setSetting, mailbox } from "./config";
import { logRun } from "./runs";
import { notify } from "./push";

/**
 * Inbox placement: what keeps NEXGEN's emails out of spam.
 *  1. The sending domain proves the mail is really from it: SPF, DKIM and DMARC records (checked here, live from DNS).
 *  2. A new mailbox warms up slowly: 10 a day, then 20, 35, and only then the daily limit you set.
 *  3. Human rhythm: a few minutes apart with random spacing, on US weekdays during business hours.
 *  4. Bounces are caught from the inbox: that address is never written to again, and sending pauses itself if too many bounce.
 *  5. Plain personal emails: no images, no tracking pixels, no link shorteners, one-click unsubscribe header.
 */

const FREE = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|zohomail|gmx)\.[a-z.]+$/i;
const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "dkim", "mail", "k1", "k2", "s1", "s2", "smtp", "zoho", "zmail", "spacemail", "sm", "mx", "key1"];

const txt = async (name: string) => {
  try {
    return (await resolveTxt(name)).map((r) => r.join(""));
  } catch {
    return [];
  }
};

export interface DomainCheck {
  email: string;
  domain: string;
  free: boolean;
  mx: boolean;
  spf: { ok: boolean; record: string | null };
  dkim: { ok: boolean; selector: string | null };
  dmarc: { ok: boolean; record: string | null; policy: string | null };
  /** false = sending is held until the fixes are made */
  ready: boolean;
  fixes: string[];
  checked_at: string;
}

/** Which SPF include each mail provider needs (shown in the fix list). */
function providerInclude(smtpHost: string) {
  if (/google|gmail/i.test(smtpHost)) return "include:_spf.google.com";
  if (/office365|outlook/i.test(smtpHost)) return "include:spf.protection.outlook.com";
  if (/zoho/i.test(smtpHost)) return "include:zoho.com";
  if (/spacemail/i.test(smtpHost)) return "include:spf.spacemail.com";
  return "include:<your mail provider's SPF>";
}

export async function checkDomain(email: string, smtpHost = ""): Promise<DomainCheck> {
  const domain = email.split("@").pop()!.toLowerCase().trim();
  const free = FREE.test(domain);
  const [mxs, root, dmarcTxt] = await Promise.all([resolveMx(domain).catch(() => []), txt(domain), txt(`_dmarc.${domain}`)]);
  const spf = root.find((r) => /^v=spf1\b/i.test(r)) ?? null;
  const dmarc = dmarcTxt.find((r) => /^v=DMARC1\b/i.test(r)) ?? null;
  let dkimSel: string | null = null;
  if (!free) {
    const hits = await Promise.all(DKIM_SELECTORS.map(async (s) => ((await txt(`${s}._domainkey.${domain}`)).some((r) => /p=[A-Za-z0-9+/]{40,}/.test(r)) ? s : null)));
    dkimSel = hits.find(Boolean) ?? null;
  }
  const out: DomainCheck = {
    email,
    domain,
    free,
    mx: mxs.length > 0,
    spf: { ok: free || Boolean(spf), record: spf },
    dkim: { ok: free || Boolean(dkimSel), selector: dkimSel },
    dmarc: { ok: free || Boolean(dmarc), record: dmarc, policy: dmarc ? (/p=(\w+)/i.exec(dmarc)?.[1] ?? null) : null },
    ready: false,
    fixes: [],
    checked_at: new Date().toISOString(),
  };
  if (free) {
    out.fixes.push(
      `${domain} is a free mailbox: the provider signs your mail, but free addresses doing outreach get filtered more often. A mailbox on your own domain (e.g. you@yourcompany.com) lands in the inbox far more reliably — keep this one under about 30 emails a day.`,
    );
  } else {
    if (!out.mx) out.fixes.push(`${domain} has no MX record — replies can't reach you and many servers reject the mail. Add your mail provider's MX records.`);
    if (!spf) out.fixes.push(`Add an SPF record: TXT on ${domain} → "v=spf1 ${providerInclude(smtpHost)} ~all"`);
    else if (smtpHost && !spf.includes(providerInclude(smtpHost).replace("include:", "")) && !providerInclude(smtpHost).includes("<"))
      out.fixes.push(`Your SPF record doesn't list your mail provider. Add "${providerInclude(smtpHost)}" to: ${spf}`);
    if (!dkimSel)
      out.fixes.push(`DKIM signing wasn't found on ${domain}. Turn on DKIM in your mail provider's admin panel and add the TXT record it gives you (it looks like <selector>._domainkey.${domain}).`);
    if (!dmarc) out.fixes.push(`Add a DMARC record: TXT on _dmarc.${domain} → "v=DMARC1; p=none; rua=mailto:${email}"`);
  }
  // DKIM selectors vary by provider, so a missing one is a warning; no SPF or no MX is a hard stop.
  out.ready = out.spf.ok && (out.free || out.mx);
  await setSetting("deliverability", out);
  return out;
}

export async function currentCheck(): Promise<DomainCheck | null> {
  const m = await mailbox();
  if (!m) return null;
  const saved = await getSetting<DomainCheck>("deliverability");
  if (saved && saved.email === m.email && Date.now() - Date.parse(saved.checked_at) < 6 * 3600_000) return saved;
  return checkDomain(m.email, m.smtp_host);
}

/** New mailboxes ramp up: sending 50 cold emails on day one is the quickest way into spam. */
/** Warm-up steps for a new sending domain: emails per day by days since the mailbox was connected. */
export const WARMUP = [
  { upToDay: 3, perDay: 5 },
  { upToDay: 7, perDay: 10 },
  { upToDay: 14, perDay: 20 },
  { upToDay: 21, perDay: 35 },
] as const;

/** The US business-day window emails are spread across (8 am – 5 pm Eastern = 540 minutes). */
export const WINDOW_MIN = 540;

/**
 * Today's allowance for the connected mailbox. The count restarts when a new mailbox is connected
 * (settings "mailbox_since"), because a new domain has no reputation yet.
 */
export async function warmupCap(dailyLimit: number): Promise<{ cap: number; day: number; spreadMin: number }> {
  let since = await getSetting<string>("mailbox_since");
  if (!since) {
    const r = await one<{ first: string | null }>(`select min(sent_at) as first from email_log where status = 'sent' and kind <> 'reply'`);
    since = r?.first ?? new Date().toISOString();
  }
  const day = Math.floor((Date.now() - Date.parse(since)) / 86_400_000) + 1;
  const step = WARMUP.find((w) => day <= w.upToDay);
  const cap = Math.max(1, Math.min(dailyLimit, step ? step.perDay : dailyLimit));
  // Spread the day's emails evenly across the business window.
  return { cap, day, spreadMin: Math.round(WINDOW_MIN / cap) };
}

/** Emails that count toward today's allowance (tests to your own address don't). */
export async function sentLast24h(): Promise<{ today: number; last: string | null }> {
  const r = await one<{ today: number; last: string | null }>(
    `select count(*) filter (where e.sent_at > now() - interval '24 hours' and coalesce(l.source, '') <> 'test') as today, max(e.sent_at) as last
     from email_log e left join leads l on l.id = e.lead_id where e.status = 'sent'`,
  );
  return { today: Number(r?.today ?? 0), last: r?.last ?? null };
}

/** The next moment inside the US business window (checked in 5-minute steps, up to 4 days ahead). */
export function nextWindowStart(from = new Date()): Date {
  for (let t = from.getTime(), end = t + 4 * 86_400_000; t < end; t += 5 * 60_000) if (inUsBusinessHours(new Date(t))) return new Date(t);
  return from;
}

/** What the queue will do next — shown in the app so "queued" always says when. */
export async function sendPlan(): Promise<{ queued: number; nextAt: string | null; why: string; day: number; perDay: number; spreadMin: number; sentToday: number }> {
  const s = (await import("./config")).getSettings;
  const settings = await s();
  const warm = await warmupCap(settings.daily_limit);
  const q0 = await one<{ n: number }>(`select count(*) as n from email_log where status = 'queued'`);
  const queued = Number(q0?.n ?? 0);
  const st = await sentLast24h();
  const base = { queued, day: warm.day, perDay: warm.cap, spreadMin: warm.spreadMin, sentToday: st.today };
  const paused = await sendPaused();
  if (paused) return { ...base, nextAt: null, why: `Sending paused: ${paused.reason}` };
  if (!(await mailbox())) return { ...base, nextAt: null, why: "No mailbox connected" };
  const dom = await getSetting<DomainCheck>("deliverability");
  if (dom && !dom.ready) return { ...base, nextAt: null, why: `Held until ${dom.domain}'s mail records are fixed` };
  const now = new Date();
  if (settings.us_business_hours && !inUsBusinessHours(now)) return { ...base, nextAt: nextWindowStart(now).toISOString(), why: "Waiting for US business hours (weekdays 8 am – 5 pm Eastern)" };
  if (st.today >= warm.cap) {
    const after = new Date(Date.parse(st.last ?? now.toISOString()) + 86_400_000);
    return { ...base, nextAt: (settings.us_business_hours ? nextWindowStart(after) : after).toISOString(), why: `Today's warm-up allowance (${warm.cap}) is used` };
  }
  const at = await getSetting<string>("next_send_at");
  if (at && Date.parse(at) > now.getTime()) return { ...base, nextAt: at, why: `Spacing emails about ${warm.spreadMin} minutes apart` };
  return { ...base, nextAt: now.toISOString(), why: "Sending within the next minute" };
}

/** US weekdays, 8 am – 5 pm Eastern (5 am – 2 pm Pacific): when owners read email and the send looks like a person's. */
export function inUsBusinessHours(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(d);
  const wd = p.find((x) => x.type === "weekday")?.value ?? "";
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24;
  return !["Sat", "Sun"].includes(wd) && h >= 8 && h < 17;
}

/** Spacing between emails: the gap you set plus up to 60% random extra, so sends don't arrive like a machine's. */
export async function nextSendAllowed(): Promise<boolean> {
  const at = await getSetting<string>("next_send_at");
  return !at || Date.parse(at) <= Date.now();
}
export async function scheduleNextSend(gapMin: number) {
  // ±25% so the sends don't arrive on a fixed beat.
  const ms = Math.max(1, gapMin) * 60_000 * (0.75 + Math.random() * 0.5);
  await setSetting("next_send_at", new Date(Date.now() + ms).toISOString());
}

export async function sendPaused(): Promise<{ at: string; reason: string } | null> {
  return (await getSetting<{ at: string; reason: string } | null>("send_paused")) ?? null;
}

/**
 * A bounce notice names the address that failed. That address is marked bounced and never emailed again;
 * if more than 5% of the last 50 emails bounced, sending pauses until you resume it in Settings.
 */
export async function recordBounces(addresses: string[]): Promise<number> {
  if (!addresses.length) return 0;
  const hit = await q<{ lead_id: string; recipient_email: string }>(
    `select distinct lead_id, recipient_email from email_log where status = 'sent' and recipient_email = any($1)`,
    [addresses.map((a) => a.toLowerCase())],
  );
  for (const h of hit) {
    await q(`update email_log set status = 'bounced', error = 'Bounced — address does not accept mail' where lead_id = $1 and recipient_email = $2 and status = 'sent'`, [h.lead_id, h.recipient_email]);
    await q(`update leads set email_status = 'bounced', updated_at = now() where id = $1`, [h.lead_id]);
    await q(`update email_log set status = 'cancelled', error = 'Address bounced' where lead_id = $1 and status = 'queued'`, [h.lead_id]);
    await logRun("send", false, `${h.recipient_email} bounced — it won't be emailed again`);
  }
  if (hit.length) {
    const r = await one<{ sent: number; bounced: number }>(
      `select count(*) as sent, count(*) filter (where status = 'bounced') as bounced
       from (select status from email_log where status in ('sent','bounced') and kind <> 'reply' order by coalesce(sent_at, created_at) desc limit 50) x`,
    );
    const sent = Number(r?.sent ?? 0);
    const bounced = Number(r?.bounced ?? 0);
    if (bounced >= 3 && bounced / Math.max(sent, 1) > 0.05 && !(await sendPaused())) {
      const reason = `${bounced} of the last ${sent} emails bounced — sending paused to protect your mailbox's reputation`;
      await setSetting("send_paused", { at: new Date().toISOString(), reason });
      await logRun("send", false, reason);
      await notify({ title: "Sending paused", body: reason, url: "/settings", tag: "send-paused" });
    }
  }
  return hit.length;
}
