import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { q, one } from "./db";

export type Category = "tax" | "court" | "debt";
export const CATEGORIES: Category[] = ["court", "tax", "debt"];
export const CATEGORY_LABEL: Record<Category, string> = { tax: "Tax Debt", court: "Courts", debt: "Commercial Debt" };
export const CATEGORY_NAME: Record<Category, string> = {
  court: "Courts",
  tax: "Tax Debt",
  debt: "Commercial Debt Lawsuits",
};

export interface CategoryConf {
  on: boolean;
  query: string;
  /** Update B: each category sends its own saved template automatically when this is on. */
  auto_send: boolean;
}

export interface Settings {
  auto_send: boolean;
  send_gap_min: number;
  daily_limit: number;
  ingest_every_min: number;
  lookback_days: number;
  auto_followup_days: number;
  /** BetterContact charges up to 10 credits per mobile number vs ~1 per email: off by default. */
  find_phones: boolean;
  /** Send only on US weekdays, 8 am – 5 pm Eastern (better inbox placement and replies). */
  us_business_hours: boolean;
  /** Also send on Saturdays and Sundays (same hours). */
  send_weekends: boolean;
  /** Warm-up pace: minutes between emails while a new mailbox warms up. */
  warmup_gap_min: number;
  /** Research backfill leads automatically too (emails only), until BetterContact credits run out. */
  enrich_backfill: boolean;
  /** Individuals (not companies) in tax/debt suits are kept only when the amount owed is at least this much. */
  individual_min_amount: number;
  /** Tax arrears: California CDTFA Top 500 delinquent sales & use taxpayers. */
  source_cdtfa: boolean;
  /** Bank-loan defaults: SBA 7(a) loans charged off. */
  source_sba: boolean;
  /** Only charge-offs from the last N months. */
  sba_months: number;
  /** State delinquent-tax lists to import (see lib/statetax.ts). */
  tax_states: string[];
  /** Only companies owing at least this much on a state tax list. */
  tax_min_amount: number;
  /** Paid Apify lien feeds to run (see lib/apify.ts). */
  apify_feeds: string[];
  /** USD per day across all Apify feeds. */
  apify_daily_budget: number;
  sender_name: string;
  physical_address: string;
  categories: Record<Category, CategoryConf>;
}

// CourtListener RECAP search queries. Editable in Settings.
export const DEFAULT_QUERIES: Record<Category, string> = {
  court: `("chapter 11" OR "subchapter v" OR chapter:11)`,
  tax: `suitNature:(Taxes OR IRS) AND caseName:("United States" OR USA)`,
  debt: `suitNature:("Negotiable Instrument" OR "Contract: Other" OR "Recovery of Overpayment") AND caseName:(capital OR funding OR financial OR finance OR bank OR credit OR lending OR loan OR leasing OR advance OR factoring OR receivables OR ventures OR merchant OR acceptance)`,
};

export const DEFAULT_SETTINGS: Settings = {
  auto_send: false,
  send_gap_min: 2,
  daily_limit: 50,
  ingest_every_min: 20,
  lookback_days: 2,
  auto_followup_days: 0,
  find_phones: false,
  us_business_hours: true,
  send_weekends: true,
  warmup_gap_min: 120,
  enrich_backfill: true,
  individual_min_amount: 5000,
  source_cdtfa: true,
  source_sba: true,
  sba_months: 12,
  tax_states: ["ca_ftb", "fl", "de", "sd", "wy"],
  tax_min_amount: 5000,
  apify_feeds: ["fl_ftl", "ny_llc", "ny_inc"],
  apify_daily_budget: 1,
  sender_name: "",
  physical_address: "",
  categories: {
    court: { on: true, query: DEFAULT_QUERIES.court, auto_send: false },
    tax: { on: true, query: DEFAULT_QUERIES.tax, auto_send: false },
    debt: { on: true, query: DEFAULT_QUERIES.debt, auto_send: false },
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
  const cats = {} as Record<Category, CategoryConf>;
  for (const c of CATEGORIES) cats[c] = { ...DEFAULT_SETTINGS.categories[c], ...(s.categories?.[c] ?? {}) };
  return { ...DEFAULT_SETTINGS, ...s, categories: cats };
}

export async function saveSettings(patch: Partial<Settings>) {
  const cur = await getSettings();
  const cats = { ...cur.categories };
  for (const c of CATEGORIES) if (patch.categories?.[c]) cats[c] = { ...cur.categories[c], ...patch.categories[c] };
  const next = { ...cur, ...patch, categories: cats };
  next.send_gap_min = clamp(next.send_gap_min, 0, 1440);
  next.daily_limit = clamp(next.daily_limit, 1, 2000);
  next.ingest_every_min = clamp(next.ingest_every_min, 1, 1440);
  next.lookback_days = clamp(next.lookback_days, 1, 60);
  next.auto_followup_days = clamp(next.auto_followup_days, 0, 60);
  next.individual_min_amount = clamp(next.individual_min_amount, 0, 10_000_000);
  next.sba_months = clamp(next.sba_months, 1, 72);
  next.tax_min_amount = clamp(next.tax_min_amount, 0, 100_000_000);
  next.apify_feeds = Array.isArray(next.apify_feeds) ? next.apify_feeds.map(String) : DEFAULT_SETTINGS.apify_feeds;
  next.apify_daily_budget = Math.min(100, Math.max(0, Math.round(Number(next.apify_daily_budget) * 100) / 100 || 0));
  next.tax_states = Array.isArray(next.tax_states) ? next.tax_states.map(String) : DEFAULT_SETTINGS.tax_states;
  next.source_cdtfa = Boolean(next.source_cdtfa);
  next.source_sba = Boolean(next.source_sba);
  next.find_phones = Boolean(next.find_phones);
  next.us_business_hours = next.us_business_hours !== false;
  next.send_weekends = next.send_weekends !== false;
  next.warmup_gap_min = Math.min(600, Math.max(5, Math.round(Number(next.warmup_gap_min)) || 120));
  next.enrich_backfill = Boolean(next.enrich_backfill);
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

export type SecretName = "COURTLISTENER_API_KEY" | "BETTERCONTACT_API_KEY" | "OPENAI_API_KEY" | "RESEND_API_KEY" | "OPENCORPORATES_API_KEY" | "HUNTER_API_KEY" | "SERPER_API_KEY" | "APIFY_API_TOKEN";
export const SECRET_NAMES: SecretName[] = ["COURTLISTENER_API_KEY", "BETTERCONTACT_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "OPENCORPORATES_API_KEY", "HUNTER_API_KEY", "SERPER_API_KEY", "APIFY_API_TOKEN"];

/**
 * API keys never contain spaces. Pasting often brings extras along: "Token abc…", "X-API-Key: abc…",
 * "BETTERCONTACT_API_KEY=abc…", quotes, line breaks or invisible characters. Strip all of that.
 */
export function cleanKey(name: SecretName, raw: string): string {
  let k = raw.replace(/[​-‍⁠﻿ ]/g, " ").trim();
  k = k.replace(/^["'`]+|["'`;,]+$/g, "").trim();
  k = k.replace(/^[A-Z_]*API_KEY\s*[=:]\s*/i, "");
  k = k.replace(/^(authorization\s*:\s*)?(token|bearer)\s+/i, "");
  k = k.replace(/^x-api-key\s*:\s*/i, "");
  k = k.replace(/^["'`]+|["'`;,]+$/g, "");
  k = k.replace(/\s+/g, "");
  if (name === "COURTLISTENER_API_KEY") {
    const hex = /[0-9a-f]{40}/i.exec(k);
    if (hex) k = hex[0];
  }
  return k;
}

/** A description of a key's shape that is safe to show: never the key itself. */
export function keyShape(name: SecretName, raw: string) {
  const cleaned = cleanKey(name, raw);
  const notes: string[] = [`saved key is ${cleaned.length} characters`];
  if (raw.trim() !== cleaned) notes.push("extra text/spaces around it are now ignored");
  if (name === "COURTLISTENER_API_KEY" && !/^[0-9a-f]{40}$/i.test(cleaned)) notes.push("a CourtListener token is exactly 40 characters of 0-9 and a-f");
  return notes.join("; ");
}

export async function rawSecret(name: SecretName): Promise<string | null> {
  const env = process.env[name];
  if (env) return env;
  const v = await getSetting<string>(`secret:${name}`);
  if (!v) return null;
  try {
    return unseal(v);
  } catch {
    return null;
  }
}

export async function secret(name: SecretName): Promise<string | null> {
  const raw = await rawSecret(name);
  const k = raw ? cleanKey(name, raw) : null;
  return k || null;
}

export async function saveSecret(name: SecretName, value: string | null) {
  const k = value ? cleanKey(name, value) : "";
  if (!k) await q(`delete from settings where key = $1`, [`secret:${name}`]);
  else await setSetting(`secret:${name}`, seal(k));
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

/**
 * Several mailboxes can be connected; each category (Court / Tax / Debt) sends from the mailbox it's assigned to
 * (settings "mailbox_routes": { tax: "richard@…", debt: "info@…" }). A category with no assignment uses the first mailbox.
 * Passwords are stored encrypted (secret:MAILBOXES); a single older secret:MAILBOX is picked up automatically.
 */
export async function mailboxes(): Promise<Mailbox[]> {
  const out: Mailbox[] = [];
  if (process.env.MAILBOX_EMAIL && process.env.MAILBOX_PASSWORD) {
    const e = process.env.MAILBOX_EMAIL;
    const p = presetFor(e);
    out.push({
      email: e,
      password: process.env.MAILBOX_PASSWORD,
      smtp_host: process.env.SMTP_HOST || p.smtp_host,
      smtp_port: Number(process.env.SMTP_PORT || p.smtp_port),
      imap_host: process.env.IMAP_HOST || p.imap_host,
      imap_port: Number(process.env.IMAP_PORT || p.imap_port),
    });
  }
  const list = await getSetting<string>("secret:MAILBOXES");
  if (list) {
    try {
      for (const m of JSON.parse(unseal(list)) as Mailbox[]) if (!out.some((x) => x.email === m.email)) out.push(m);
    } catch {
      /* unreadable — treated as none */
    }
  } else {
    const v = await getSetting<string>("secret:MAILBOX");
    if (v) {
      try {
        out.push(JSON.parse(unseal(v)) as Mailbox);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

async function saveMailboxList(list: Mailbox[]) {
  const own = list.filter((m) => m.email !== process.env.MAILBOX_EMAIL);
  await setSetting("secret:MAILBOXES", seal(JSON.stringify(own)));
  await q(`delete from settings where key = 'secret:MAILBOX'`);
}

/** Add a mailbox, or update it if the address is already connected. */
export async function addMailbox(m: Mailbox) {
  const list = (await mailboxes()).filter((x) => x.email.toLowerCase() !== m.email.toLowerCase());
  await saveMailboxList([...list, m]);
}

export async function removeMailbox(email: string) {
  await saveMailboxList((await mailboxes()).filter((x) => x.email.toLowerCase() !== email.toLowerCase()));
  const routes = await mailboxRoutes();
  for (const c of CATEGORIES) if (routes[c]?.toLowerCase() === email.toLowerCase()) delete routes[c];
  await setSetting("mailbox_routes", routes);
}

export async function mailboxRoutes(): Promise<Partial<Record<Category, string>>> {
  return (await getSetting<Partial<Record<Category, string>>>("mailbox_routes")) ?? {};
}

/** Assign a category to a mailbox (one mailbox per category). */
export async function routeCategory(category: Category, email: string | null) {
  const routes = await mailboxRoutes();
  if (email) routes[category] = email.toLowerCase();
  else delete routes[category];
  await setSetting("mailbox_routes", routes);
}

/**
 * The mailbox a category sends from. Court, Tax and Debt are kept separate: once categories are assigned,
 * each one sends only from its own mailbox — a category with no mailbox (or one that isn't connected) waits,
 * it never borrows another category's address. Only a simple one-mailbox setup with no assignments at all
 * sends everything from that mailbox.
 */
export async function mailboxFor(category?: Category | null): Promise<Mailbox | null> {
  const list = await mailboxes();
  if (!list.length) return null;
  const routes = await mailboxRoutes();
  if (category && Object.keys(routes).length) {
    const to = routes[category];
    return to ? (list.find((m) => m.email.toLowerCase() === to) ?? null) : null;
  }
  return list[0];
}

/** Categories that can't send right now: no mailbox assigned, or the assigned one isn't connected. */
export async function categoriesWithoutMailbox(): Promise<{ category: Category; assigned: string | null }[]> {
  const out: { category: Category; assigned: string | null }[] = [];
  const routes = await mailboxRoutes();
  for (const c of CATEGORIES) if (!(await mailboxFor(c))) out.push({ category: c, assigned: routes[c] ?? null });
  return out;
}

/** Which categories a mailbox sends for. */
export async function categoriesFor(email: string): Promise<Category[]> {
  const out: Category[] = [];
  for (const c of CATEGORIES) if ((await mailboxFor(c))?.email.toLowerCase() === email.toLowerCase()) out.push(c);
  return out;
}

/** The first connected mailbox (kept for callers that don't care about categories). */
export async function mailbox(): Promise<Mailbox | null> {
  return (await mailboxes())[0] ?? null;
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

// ---- Email templates (Update B: one builder per category) ----

export type TemplateKind = "initial" | "followup";
export interface Template {
  kind: TemplateKind;
  category: Category;
  subject: string;
  body: string;
  saved: boolean;
  updated_at?: string | null;
}

const SIGN = `\n\nBest regards,\n{{your_name}}`;

export const DEFAULT_TEMPLATES: Record<Category, Record<TemplateKind, { subject: string; body: string }>> = {
  court: {
    initial: {
      subject: "{{company_name}} — your {{distress_type}} case[[ {{case_number}}]]",
      body:
        `Hi {{first_name}},\n\nI saw {{what_happened}}.[[ The schedules show {{total_debt}} in liabilities.]]\n\n` +
        `The next few weeks decide how much of the plan you control. I work with owners in restructuring to keep the business theirs and the creditors aligned. ` +
        `Would a 15-minute call this week help?` +
        SIGN,
    },
    followup: {
      subject: "Re: {{company_name}} — your {{distress_type}} case[[ {{case_number}}]]",
      body:
        `Hi {{first_name}},\n\nFollowing up on my note about {{company_name}}'s case[[ ({{case_number}})]]. If now isn't the right time, reply "not now" and I won't write again.` +
        SIGN,
    },
  },
  tax: {
    initial: {
      subject: "{{company_name}} — the tax balance with {{owed_to}}",
      body:
        `Hi {{first_name}},\n\nI came across {{what_happened}}.[[ The balance on record for {{company_name}} is {{amount_owed}}.]]\n\n` +
        `There is usually room to settle, set up an installment plan or challenge the assessment before collection escalates. ` +
        `Would a short call this week be useful?` +
        SIGN,
    },
    followup: {
      subject: "Re: {{company_name}} — the tax balance with {{owed_to}}",
      body: `Hi {{first_name}},\n\nCircling back on the[[ {{amount_owed}}]] balance with {{owed_to}}. If it's already handled, just reply and I'll close my file.` + SIGN,
    },
  },
  debt: {
    initial: {
      subject: "{{company_name}} — the balance owed to {{owed_to}}",
      body:
        `Hi {{first_name}},\n\nI came across {{what_happened}}.[[ The amount on record is {{amount_owed}}.]]\n\n` +
        `Lenders often settle for far less than the full balance when the business comes to them with a plan. ` +
        `I help owners negotiate these down and keep operating. Open to a quick call?` +
        SIGN,
    },
    followup: {
      subject: "Re: {{company_name}} — the balance owed to {{owed_to}}",
      body: `Hi {{first_name}},\n\nFollowing up on the balance with {{owed_to}}. If now isn't the right time, reply "not now" and I won't write again.` + SIGN,
    },
  },
};

const tid = (kind: TemplateKind, category: Category) => `${kind}:${category}`;

export async function getTemplate(kind: TemplateKind, category: Category): Promise<Template> {
  const r = await one<{ subject: string; body: string; updated_at: string }>(`select subject, body, updated_at from templates where id = $1`, [tid(kind, category)]);
  if (r) return { kind, category, subject: r.subject, body: r.body, saved: true, updated_at: r.updated_at };
  return { kind, category, ...DEFAULT_TEMPLATES[category][kind], saved: false, updated_at: null };
}

export async function saveTemplate(t: { kind: TemplateKind; category: Category; subject: string; body: string }) {
  await q(
    `insert into templates (id, subject, body, updated_at) values ($1, $2, $3, now())
     on conflict (id) do update set subject = excluded.subject, body = excluded.body, updated_at = now()`,
    [tid(t.kind, t.category), t.subject, t.body],
  );
}

/** Auto-send for a category only runs once its new-lead template has been saved. */
export async function templateSaved(category: Category) {
  return Boolean(await one(`select 1 from templates where id = $1`, [tid("initial", category)]));
}
