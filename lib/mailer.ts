import "server-only";
import nodemailer from "nodemailer";
import { randomBytes } from "node:crypto";
import { appUrl, mailbox, secret, getSettings, type Settings, type Mailbox } from "./config";

import { render as renderText, type RenderLead } from "./render";

export interface LeadVars extends RenderLead {
  [k: string]: unknown;
  id: string;
}

export function render(text: string, l: LeadVars, s: Pick<Settings, "sender_name">) {
  return renderText(text, l, s.sender_name);
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function unsubscribeUrl(leadId: string) {
  return `${appUrl()}/api/unsubscribe?id=${leadId}`;
}

function compose(body: string, leadId: string, address: string) {
  const unsub = unsubscribeUrl(leadId);
  const footerText = `\n\n--\n${address ? address + "\n" : ""}Don't want these emails? Unsubscribe: ${unsub}`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">` +
    esc(body)
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
      .join("") +
    `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${address ? esc(address) + "<br>" : ""}` +
    `Don't want these emails? <a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p></div>`;
  return { text: body + footerText, html, unsub };
}

export interface SendResult {
  messageId: string;
  via: "smtp" | "resend";
  /** The address it went out from. */
  sender: string;
}

export async function mailReady(): Promise<{ ok: boolean; via: string | null; from: string | null }> {
  const m = await mailbox();
  if (m) return { ok: true, via: "mailbox", from: m.email };
  const rk = await secret("RESEND_API_KEY");
  const from = process.env.EMAIL_FROM ?? null;
  if (rk && from) return { ok: true, via: "resend", from };
  return { ok: false, via: null, from: null };
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  body: string;
  leadId: string;
  inReplyTo?: string | null;
  /** The mailbox to send from (each category has its own); defaults to the first connected one. */
  from?: Mailbox | null;
}): Promise<SendResult> {
  const s = await getSettings();
  const { text, html, unsub } = compose(opts.body, opts.leadId, s.physical_address);
  const m = opts.from ?? (await mailbox());
  const domain = (m?.email ?? process.env.EMAIL_FROM ?? "nexgen.local").split("@").pop()!.replace(/>$/, "");
  const messageId = `<${randomBytes(12).toString("hex")}@${domain}>`;
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${unsub}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  if (opts.inReplyTo) {
    headers["In-Reply-To"] = opts.inReplyTo;
    headers["References"] = opts.inReplyTo;
  }

  if (m) {
    const t = nodemailer.createTransport({
      host: m.smtp_host,
      port: m.smtp_port,
      secure: m.smtp_port === 465,
      auth: { user: m.email, pass: m.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
    });
    await t.sendMail({
      from: s.sender_name ? { name: s.sender_name, address: m.email } : m.email,
      to: opts.to,
      subject: opts.subject,
      text,
      html,
      messageId,
      headers,
    });
    // Keep a copy in the mailbox's Sent folder so the conversation lives in one place.
    await Promise.race([
      saveToSent(m, opts.to, opts.subject, text, html, messageId, headers, s.sender_name).catch(() => {}),
      new Promise((res) => setTimeout(res, 15_000)),
    ]);
    return { messageId, via: "smtp", sender: m.email.toLowerCase() };
  }

  const rk = await secret("RESEND_API_KEY");
  const from = process.env.EMAIL_FROM;
  if (!rk || !from) throw new Error("No mailbox connected. Add one in Settings → Mailbox.");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${rk}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: s.sender_name && !from.includes("<") ? `${s.sender_name} <${from}>` : from,
      to: [opts.to],
      subject: opts.subject,
      text,
      html,
      reply_to: process.env.EMAIL_REPLY_TO || undefined,
      headers: { ...headers, "Message-ID": messageId },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { messageId, via: "resend", sender: from.toLowerCase() };
}

async function saveToSent(
  m: NonNullable<Awaited<ReturnType<typeof mailbox>>>,
  to: string,
  subject: string,
  text: string,
  html: string,
  messageId: string,
  headers: Record<string, string>,
  senderName: string,
) {
  const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
  const raw = await new MailComposer({
    from: senderName ? { name: senderName, address: m.email } : m.email,
    to,
    subject,
    text,
    html,
    messageId,
    headers,
    date: new Date(),
  })
    .compile()
    .build();
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({
    host: m.imap_host,
    port: m.imap_port,
    secure: true,
    auth: { user: m.email, pass: m.password },
    logger: false,
    socketTimeout: 20_000,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  c.on("error", () => {}); // a mail-server hiccup must never crash the run
  await c.connect();
  try {
    const boxes = await c.list();
    const sent = boxes.find((b) => b.specialUse === "\\Sent") ?? boxes.find((b) => /^(sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(b.path));
    if (sent && !/gmail/i.test(m.imap_host)) await c.append(sent.path, raw, ["\\Seen"]);
  } finally {
    await c.logout().catch(() => {});
  }
}

export async function verifyMailbox(m: NonNullable<Awaited<ReturnType<typeof mailbox>>>) {
  const t = nodemailer.createTransport({
    host: m.smtp_host,
    port: m.smtp_port,
    secure: m.smtp_port === 465,
    auth: { user: m.email, pass: m.password },
    connectionTimeout: 15_000,
  });
  await t.verify();
  const { ImapFlow } = await import("imapflow");
  const c = new ImapFlow({
    host: m.imap_host,
    port: m.imap_port,
    secure: true,
    auth: { user: m.email, pass: m.password },
    logger: false,
    socketTimeout: 20_000,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  c.on("error", () => {}); // a mail-server hiccup must never crash the run
  await c.connect();
  await c.logout().catch(() => {});
}
