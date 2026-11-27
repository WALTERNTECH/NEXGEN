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
  rawSecret,
  cleanKey,
  keyShape,
  secret,
  CATEGORY_LABEL,
  templateSaved,
  SECRET_NAMES,
  DEFAULT_QUERIES,
  type SecretName,
  type Settings,
  type Mailbox,
} from "@/lib/config";
import { verifyMailbox } from "@/lib/mailer";
import { q } from "@/lib/db";
import { ping, searchCategory, searchesLeftThisHour, ymd, RateLimited } from "@/lib/courtlistener";
import { companyFor, heuristicExtract } from "@/lib/extract";
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
    imports: await (async () => {
      const { getSetting } = await import("@/lib/config");
      const sba = await getSetting<Record<string, unknown>>("sba_import");
      return {
        cdtfa: await getSetting("cdtfa_status"),
        states: await getSetting("tax_states_status"),
        stateList: (await import("@/lib/statetax")).TAX_STATES,
        sba: sba ? { url: sba.url, offset: sba.offset, size: sba.size, scanned: sba.scanned, matched: sba.matched, added: sba.added, status: sba.status, finished_at: sba.finished_at ?? null } : null,
      };
    })(),
    link: process.env.ACCESS_KEY ? `${appUrl()}/?key=${process.env.ACCESS_KEY}` : null,
  };
}

export async function GET(req: Request) {
  const check = new URL(req.url).searchParams.get("check");
  if (check === "query") {
    // Try one category's search: how many filings match, and which of them NEXGEN would keep as leads.
    const u = new URL(req.url).searchParams;
    const cat = u.get("cat") as (typeof CATEGORIES)[number];
    if (!CATEGORIES.includes(cat)) return bad("Unknown category");
    const st = await getSettings();
    const query = u.get("q") || st.categories[cat].query;
    const days = Math.min(60, Math.max(1, Number(u.get("days")) || st.lookback_days));
    try {
      const page = await searchCategory(cat, query, { after: ymd(new Date(Date.now() - days * 86_400_000)), maxPages: 1 });
      const sample = page.dockets.slice(0, 20).map((d) => {
        const co = companyFor(cat, d);
        const x = co ? heuristicExtract(cat, d, co, []) : null;
        return { caption: d.caseName, filed: d.dateFiled, kept: Boolean(co), company: co, owner: x?.founderFullName ?? null };
      });
      return json({ ok: true, days, count: page.count, kept: sample.filter((x) => x.kept).length, sample, searchesLeft: await searchesLeftThisHour() });
    } catch (e) {
      return json({
        ok: false,
        message: e instanceof RateLimited ? "CourtListener allows 5 searches a minute and 50 an hour on this account — try again shortly." : (e as Error).message,
        searchesLeft: await searchesLeftThisHour(),
      });
    }
  }
  if (check === "courtlistener") {
    try {
      return json({ ok: true, message: await ping() });
    } catch (e) {
      const raw = await rawSecret("COURTLISTENER_API_KEY");
      const m = (e as Error).message;
      return json({
        ok: false,
        message: /401|403/.test(m)
          ? `CourtListener didn't accept this token (${raw ? keyShape("COURTLISTENER_API_KEY", raw) : "none saved"}). Copy only the long code shown under "Your API Token" on courtlistener.com and Save again.`
          : m,
      });
    }
  }
  if (check === "bettercontact") {
    try {
      const a = await account();
      return json({ ok: true, message: `connected — ${a.credits_left ?? "?"} credits left` });
    } catch (e) {
      // /account can be restricted on some plans; an enrichment lookup tells us whether the key itself is valid.
      const k = await secret("BETTERCONTACT_API_KEY");
      if (k) {
        const r = await fetch("https://app.bettercontact.rocks/api/v2/async/nexgen-key-check", { headers: { "X-API-Key": k }, cache: "no-store" }).catch(() => null);
        if (r && r.status !== 401 && r.status !== 403) return json({ ok: true, message: "key accepted by BetterContact" });
      }
      const raw = await rawSecret("BETTERCONTACT_API_KEY");
      return json({
        ok: false,
        message: /401|403/.test((e as Error).message)
          ? `BetterContact didn't accept this key (${raw ? keyShape("BETTERCONTACT_API_KEY", raw) : "none saved"}). In BetterContact open the API page, copy the API key itself (not the example code) and Save again.`
          : (e as Error).message,
      });
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
      if (v) {
        // Refuse pastes that can't be a key (page text, code examples), with a plain explanation.
        const c = cleanKey(k as SecretName, String(v));
        if (k === "COURTLISTENER_API_KEY" && !/^[0-9a-f]{40}$/i.test(c))
          return bad(`That isn't a CourtListener token. On courtlistener.com → Profile → Developer Tools → "Your API Token", copy just the 40-character code (letters a–f and numbers) and paste only that.`);
        if (c.length < 12 || c.length > 200 || /process\.env|fetch\(|https?:|[{}()<>]/i.test(c))
          return bad(`That doesn't look like an API key (it's ${c.length} characters and looks like ${/process\.env|fetch\(/i.test(c) ? "example code" : "other text"}). Copy only the key itself and paste it here.`);
      }
      await saveSecret(k as SecretName, v ? String(v) : null);
      // A new email/website source: give every company that ended without an email another search.
      if (v && ["HUNTER_API_KEY", "SERPER_API_KEY", "OPENCORPORATES_API_KEY"].includes(k)) {
        const r = await q(
          `update leads set status = 'researching', owner_lookup_at = null, updated_at = now()
           where status = 'enrichment_failed' and direct_email is null and not is_individual returning id`,
        );
        await logRun("enrich", true, `${k.replace("_API_KEY", "")} key added — ${r.length} leads queued for another email search`);
      }
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
