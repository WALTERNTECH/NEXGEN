import {
  getSettings,
  saveSettings,
  saveSecret,
  secretSource,
  mailbox,
  saveMailbox,
  presetFor,
  appUrl,
  CATEGORIES,
  CATEGORY_LABEL,
  templateSaved,
  SECRET_NAMES,
  DEFAULT_QUERIES,
  type SecretName,
  type Settings,
  type Mailbox,
} from "@/lib/config";
import { verifyMailbox } from "@/lib/mailer";
import { ping } from "@/lib/courtlistener";
import { account } from "@/lib/bettercontact";
import { webhookUrl } from "@/lib/pipeline";
import { logRun } from "@/lib/runs";
import { json, bad, body } from "../_util";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function view() {
  const m = await mailbox();
  const secrets: Record<string, string | null> = {};
  for (const n of SECRET_NAMES) secrets[n] = await secretSource(n);
  return {
    settings: await getSettings(),
    defaults: DEFAULT_QUERIES,
    secrets,
    mailbox: m ? { email: m.email, smtp_host: m.smtp_host, smtp_port: m.smtp_port, imap_host: m.imap_host, imap_port: m.imap_port, fromEnv: Boolean(process.env.MAILBOX_EMAIL) } : null,
    webhook: webhookUrl() ? webhookUrl()!.replace(/token=.*/, "token=•••") : null,
    link: process.env.ACCESS_KEY ? `${appUrl()}/?key=${process.env.ACCESS_KEY}` : null,
  };
}

export async function GET(req: Request) {
  const check = new URL(req.url).searchParams.get("check");
  if (check === "courtlistener") {
    try {
      return json({ ok: true, message: await ping() });
    } catch (e) {
      return json({ ok: false, message: (e as Error).message });
    }
  }
  if (check === "bettercontact") {
    try {
      const a = await account();
      return json({ ok: true, message: `connected — ${a.credits_left ?? "?"} credits left` });
    } catch (e) {
      return json({ ok: false, message: (e as Error).message });
    }
  }
  return json(await view());
}

export async function PUT(req: Request) {
  const b = await body<{
    settings?: Partial<Settings>;
    secrets?: Partial<Record<SecretName, string | null>>;
    mailbox?: (Partial<Mailbox> & { remove?: boolean }) | null;
  }>(req);
  if (b.settings) {
    const before = await getSettings();
    // Update B: a category's Auto-Send can only go on once that category's new-lead email has been saved.
    for (const c of CATEGORIES) {
      if (b.settings.categories?.[c]?.auto_send && !before.categories[c].auto_send && !(await templateSaved(c)))
        return bad(`Save the ${CATEGORY_LABEL[c]} new-lead email first, then turn on Auto-Send.`);
    }
    const after = await saveSettings(b.settings);
    for (const c of CATEGORIES)
      if (before.categories[c].auto_send !== after.categories[c].auto_send)
        await logRun("system", true, `${CATEGORY_LABEL[c]} Auto-Send turned ${after.categories[c].auto_send ? "ON" : "OFF"}`);
  }
  if (b.secrets) {
    for (const [k, v] of Object.entries(b.secrets)) {
      if (!SECRET_NAMES.includes(k as SecretName)) continue;
      await saveSecret(k as SecretName, v ? String(v) : null);
    }
  }
  if (b.mailbox) {
    if (b.mailbox.remove) await saveMailbox(null);
    else {
      const email = String(b.mailbox.email ?? "").trim().toLowerCase();
      const password = String(b.mailbox.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) return bad("Enter the mailbox address and its password (or app password)");
      const p = presetFor(email);
      const m: Mailbox = {
        email,
        password,
        smtp_host: String(b.mailbox.smtp_host || p.smtp_host).trim(),
        smtp_port: Number(b.mailbox.smtp_port || p.smtp_port),
        imap_host: String(b.mailbox.imap_host || p.imap_host).trim(),
        imap_port: Number(b.mailbox.imap_port || p.imap_port),
      };
      try {
        await verifyMailbox(m);
      } catch (e) {
        return bad(`Couldn't sign in to the mailbox: ${(e as Error).message}`);
      }
      await saveMailbox(m);
      await logRun("system", true, `Mailbox ${email} connected`);
    }
  }
  return json(await view());
}
