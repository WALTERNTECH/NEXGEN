import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { q, one } from "./db";

export type Category = "tax" | "court" | "debt";
export const CATEGORIES: Category[] = ["court", "tax", "debt"];
export const CATEGORY_LABEL: Record<Category, string> = { tax: "Tax", court: "Court", debt: "Debt" };

export interface CategoryConf {
  on: boolean;
  query: string;
}

export interface Settings {
  auto_send: boolean;
  send_gap_min: number;
  daily_limit: number;
  ingest_every_min: number;
  lookback_days: number;
  auto_followup_days: number;
  sender_name: string;
  physical_address: string;
  categories: Record<Category, CategoryConf>;
}

// CourtListener RECAP search queries. Editable in Settings.
export const DEFAULT_QUERIES: Record<Category, string> = {
  court: `("chapter 11" OR "subchapter v" OR chapter:11)`,
  tax: `suitNature:(Taxes OR IRS)`,
  debt: `suitNature:("Negotiable Instrument" OR "Contract: Other" OR "Recovery of Overpayment")`,
};

export const DEFAULT_SETTINGS: Settings = {
  auto_send: false,
  send_gap_min: 2,
  daily_limit: 50,
  ingest_every_min: 15,
  lookback_days: 7,
  auto_followup_days: 0,
  sender_name: "",
  physical_address: "",
  categories: {
    court: { on: true, query: DEFAULT_QUERIES.court },
    tax: { on: true, query: DEFAULT_QUERIES.tax },
    debt: { on: true, query: DEFAULT_QUERIES.debt },
  },
};

export async function getSetting<T>(key: string): Promise<T | null> {
  const r = await one<{ value: T }>(`select value from settings where key = $1`, [key]);
  return r ? r.value : null;
}

export async function setSetting(key: string, value: unknown) {
  await q(
    `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function getSettings(): Promise<Settings> {
  const s = (await getSetting<Partial<Settings>>("app")) ?? {};
  const cats = { ...DEFAULT_SETTINGS.categories, ...(s.categories ?? {}) };
  return { ...DEFAULT_SETTINGS, ...s, categories: cats };
}

export async function saveSettings(patch: Partial<Settings>) {
  const cur = await getSettings();
  const next = { ...cur, ...patch, categories: { ...cur.categories, ...(patch.categories ?? {}) } };
  next.send_gap_min = clamp(next.send_gap_min, 0, 1440);
  next.daily_limit = clamp(next.daily_limit, 1, 2000);
  next.ingest_every_min = clamp(next.ingest_every_min, 1, 1440);
  next.lookback_days = clamp(next.lookback_days, 1, 60);
  next.auto_followup_days = clamp(next.auto_followup_days, 0, 60);
  await setSetting("app", next);
  return next;
}

function clamp(n: unknown, lo: number, hi: number) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

// ---- Secrets: environment first, then values saved (encrypted) from the Settings page. ----

function masterKey() {
  const k = process.env.MASTER_KEY;
  if (k) return Buffer.from(k, "base64");
  // Local development only.
  return createHash("sha256").update("nexgen-local-dev").digest();
}

export function seal(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function unseal(blob: string) {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", masterKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export type SecretName = "COURTLISTENER_API_KEY" | "BETTERCONTACT_API_KEY" | "OPENAI_API_KEY" | "RESEND_API_KEY";
export const SECRET_NAMES: SecretName[] = ["COURTLISTENER_API_KEY", "BETTERCONTACT_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY"];

export async function secret(name: SecretName): Promise<string | null> {
  const env = process.env[name];
  if (env) return env.trim();
  const v = await getSetting<string>(`secret:${name}`);
  if (!v) return null;
  try {
    return unseal(v);
  } catch {
    return null;
  }
}

export async function saveSecret(name: SecretName, value: string | null) {
  if (!value) await q(`delete from settings where key = $1`, [`secret:${name}`]);
  else await setSetting(`secret:${name}`, seal(value.trim()));
}

export async function secretSource(name: SecretName): Promise<"env" | "saved" | null> {
  if (process.env[name]) return "env";
  return (await getSetting<string>(`secret:${name}`)) ? "saved" : null;
}

export interface Mailbox {
  email: string;
  password: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
}

export async function mailbox(): Promise<Mailbox | null> {
  if (process.env.MAILBOX_EMAIL && process.env.MAILBOX_PASSWORD) {
    const e = process.env.MAILBOX_EMAIL;
    const p = presetFor(e);
    return {
      email: e,
      password: process.env.MAILBOX_PASSWORD,
      smtp_host: process.env.SMTP_HOST || p.smtp_host,
      smtp_port: Number(process.env.SMTP_PORT || p.smtp_port),
      imap_host: process.env.IMAP_HOST || p.imap_host,
      imap_port: Number(process.env.IMAP_PORT || p.imap_port),
    };
  }
  const v = await getSetting<string>("secret:MAILBOX");
  if (!v) return null;
  try {
    return JSON.parse(unseal(v)) as Mailbox;
  } catch {
    return null;
  }
}

export async function saveMailbox(m: Mailbox | null) {
  if (!m) await q(`delete from settings where key = 'secret:MAILBOX'`);
  else await setSetting("secret:MAILBOX", seal(JSON.stringify(m)));
}

export function presetFor(email: string) {
  const d = email.split("@")[1]?.toLowerCase() ?? "";
  if (d === "gmail.com" || d === "googlemail.com")
    return { smtp_host: "smtp.gmail.com", smtp_port: 465, imap_host: "imap.gmail.com", imap_port: 993 };
  if (/outlook|hotmail|live\.com|office365/.test(d))
    return { smtp_host: "smtp.office365.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 };
  if (/yahoo/.test(d)) return { smtp_host: "smtp.mail.yahoo.com", smtp_port: 465, imap_host: "imap.mail.yahoo.com", imap_port: 993 };
  if (/zoho/.test(d)) return { smtp_host: "smtp.zoho.com", smtp_port: 465, imap_host: "imap.zoho.com", imap_port: 993 };
  // Spacemail (Spaceship) and most hosted mailboxes.
  return { smtp_host: "mail.spacemail.com", smtp_port: 465, imap_host: "mail.spacemail.com", imap_port: 993 };
}

export function appUrl() {
  const u = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (u) return u.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:5340";
}

// ---- Email templates ----

export type TemplateId = "initial" | "followup";
export interface Template {
  id: TemplateId;
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES: Record<TemplateId, Template> = {
  initial: {
    id: "initial",
    subject: "{{company_name}} — a question about the {{distress_type}} filing",
    body: `Hi {{first_name}},

I saw that {{company_name}} has a {{distress_type}} matter on file ({{days_in_distress}} days ago). Owners in that position usually have a short window to restructure on their own terms before creditors set the pace.

I help business owners work through tax, lender and court pressure and come out with the company still theirs. Would a 15-minute call this week be useful?

Best regards,
{{sender_name}}`,
  },
  followup: {
    id: "followup",
    subject: "Re: {{company_name}} — a question about the {{distress_type}} filing",
    body: `Hi {{first_name}},

Following up on my note from last week about {{company_name}}. If now isn't the right time, just reply "not now" and I won't write again.

If it is, I can share how other owners in a similar position handled the first 30 days.

Best regards,
{{sender_name}}`,
  },
};

export async function getTemplate(id: TemplateId): Promise<Template> {
  const r = await one<{ subject: string; body: string }>(`select subject, body from templates where id = $1`, [id]);
  return r ? { id, subject: r.subject, body: r.body } : DEFAULT_TEMPLATES[id];
}

export async function saveTemplate(t: Template) {
  await q(
    `insert into templates (id, subject, body, updated_at) values ($1, $2, $3, now())
     on conflict (id) do update set subject = excluded.subject, body = excluded.body, updated_at = now()`,
    [t.id, t.subject, t.body],
  );
}
