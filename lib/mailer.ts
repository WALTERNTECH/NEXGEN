import "server-only";
import nodemailer from "nodemailer";
import { randomBytes } from "node:crypto";
import { appUrl, mailbox, secret, getSettings, type Settings } from "./config";

export interface LeadVars {
  [k: string]: unknown;
  id: string;
  company_name: string;
  founder_full_name: string | null;
  founder_first_name: string | null;
  debt_amount_text: string | null;
  distress_type: string | null;
  filing_date: string | null;
  case_number: string | null;
  court_name: string | null;
}

export function daysSince(date: string | null) {
  if (!date) return 0;
  return Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86_400_000));
}

export function render(text: string, l: LeadVars, s: Pick<Settings, "sender_name">) {
  const vars: Record<string, string> = {
    first_name: l.founder_first_name || "there",
    full_name: l.founder_full_name || "",
    company_name: l.company_name,
    debt_amount: l.debt_amount_text || "the outstanding balance",
    distress_type: l.distress_type || "court",
    days_in_distress: String(daysSince(l.filing_date)),
    case_number: l.case_number || "",
    court_name: l.court_name || "",
    sender_name: s.sender_name || "",
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
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
}): Promise<SendResult> {
  const s = await getSettings();
  const { text, html, unsub } = compose(opts.body, opts.leadId, s.physical_address);
  const m = await mailbox();
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
    await saveToSent(m, opts.to, opts.subject, text, html, messageId, headers, s.sender_name).catch(() => {});
    return { messageId, via: "smtp" };
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
  return { messageId, via: "resend" };
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
  const c = new ImapFlow({ host: m.imap_host, port: m.imap_port, secure: true, auth: { user: m.email, pass: m.password }, logger: false });
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
  const c = new ImapFlow({ host: m.imap_host, port: m.imap_port, secure: true, auth: { user: m.email, pass: m.password }, logger: false });
  await c.connect();
  await c.logout().catch(() => {});
}
