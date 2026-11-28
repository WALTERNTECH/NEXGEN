import "server-only";
import { mailbox, getSetting, setSetting } from "./config";
import { q, one } from "./db";
import { notify } from "./push";
import { logRun } from "./runs";
import { sealText } from "./privacy";
import { recordBounces } from "./deliverability";

function stripQuoted(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s.+/.test(l) || /^>/.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 8000);
}

const OPT_OUT = /\b(unsubscribe|remove me|stop emailing|do not contact|don't contact|take me off|not interested)\b/i;

/** Pull new replies from the connected mailbox and attach them to their leads. */
export async function checkInbox(): Promise<{ checked: number; matched: number } | null> {
  const m = await mailbox();
  if (!m) return null;
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const c = new ImapFlow({
    host: m.imap_host,
    port: m.imap_port,
    secure: true,
    auth: { user: m.email, pass: m.password },
    logger: false,
    socketTimeout: 30_000,
  });
  await c.connect();
  let checked = 0;
  let matched = 0;
  let bounced = 0;
  const state = (await getSetting<{ uid: number; validity: string }>("imap_state")) ?? { uid: 0, validity: "" };
  try {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const status = c.mailbox && typeof c.mailbox === "object" ? c.mailbox : null;
      const validity = String(status?.uidValidity ?? "");
      let from = state.validity === validity ? state.uid + 1 : 0;
      if (!from) {
        // First run: only look at the last 3 days.
        const since = new Date(Date.now() - 3 * 86_400_000);
        const uids = (await c.search({ since }, { uid: true })) || [];
        from = uids.length ? Math.min(...uids) : (status?.uidNext ?? 1);
      }
      let maxUid = from - 1;
      for await (const msg of c.fetch(`${from}:*`, { uid: true, envelope: true }, { uid: true })) {
        if (msg.uid < from) continue;
        checked++;
        maxUid = Math.max(maxUid, msg.uid);
        const sender = msg.envelope?.from?.[0]?.address?.toLowerCase();
        if (!sender || sender === m.email.toLowerCase()) continue;
        // Bounce notices: only the failed address is taken from them, nothing is stored.
        if (/^(mailer-daemon|postmaster|mail-daemon|bounce)/i.test(sender) || /undeliver|delivery (status|failure|has failed)|returned mail|failure notice|could not be delivered/i.test(msg.envelope?.subject ?? "")) {
          const full = await c.fetchOne(String(msg.uid), { source: true }, { uid: true });
          if (full && full.source) {
            const raw = full.source.toString("utf8");
            const found = [...new Set((raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((x) => x.toLowerCase()))].filter((x) => x !== m.email.toLowerCase());
            bounced += await recordBounces(found);
          }
          continue;
        }
        const inReplyTo = msg.envelope?.inReplyTo ?? null;
        const lead =
          (await one<{ id: string; company_name: string }>(`select id, company_name from leads where lower(direct_email) = $1`, [sender])) ??
          (inReplyTo
            ? await one<{ id: string; company_name: string }>(
                `select l.id, l.company_name from email_log e join leads l on l.id = e.lead_id where e.message_id = $1 limit 1`,
                [inReplyTo],
              )
            : null);
        if (!lead) continue;
        const full = await c.fetchOne(String(msg.uid), { source: true }, { uid: true });
        if (!full || !full.source) continue;
        const parsed = await simpleParser(full.source);
        const body = stripQuoted(parsed.text ?? "");
        const messageId = parsed.messageId ?? `uid-${validity}-${msg.uid}`;
        const ins = await q(
          `insert into replies (lead_id, from_email, from_name, subject, body, message_id, received_at)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict (message_id) do nothing returning id`,
          [lead.id, sender, parsed.from?.value?.[0]?.name ?? null, sealText(parsed.subject ?? ""), sealText(body), messageId, parsed.date ?? new Date()],
        );
        if (!ins.length) continue;
        matched++;
        const optOut = OPT_OUT.test(body.split("\n").slice(0, 5).join(" "));
        await q(
          `update leads set replied_at = now(), unread_replies = unread_replies + 1, updated_at = now(),
             status = case when $2 then 'unsubscribed' else 'replied' end
           where id = $1`,
          [lead.id, optOut],
        );
        // Anything still waiting to go to this lead is cancelled once they answer.
        await q(`update email_log set status = 'cancelled', error = 'Lead replied' where lead_id = $1 and status = 'queued'`, [lead.id]);
        await notify({
          title: `Reply from ${lead.company_name}`,
          body: "Open NEXGEN to read it", // the reply itself never goes into a notification
          url: `/inbox?lead=${lead.id}`,
          tag: `reply-${lead.id}`,
        });
      }
      await setSetting("imap_state", { uid: Math.max(maxUid, state.validity === validity ? state.uid : 0), validity });
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => {});
  }
  if (matched) await logRun("inbox", true, `${matched} new repl${matched === 1 ? "y" : "ies"}`, { checked, matched });
  if (bounced) await logRun("inbox", false, `${bounced} bounced address${bounced === 1 ? "" : "es"} marked — never emailed again`);
  return { checked, matched };
}
