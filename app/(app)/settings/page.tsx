"use client";

import { useEffect, useState } from "react";
import { useFeed } from "@/components/feed";
import { api, CAT_LABEL, CATS, type Category } from "@/components/util";

interface View {
  settings: {
    ingest_every_min: number;
    lookback_days: number;
    find_phones: boolean;
    enrich_backfill: boolean;
    individual_min_amount: number;
    source_cdtfa: boolean;
    source_sba: boolean;
    sba_months: number;
    tax_states: string[];
    tax_min_amount: number;
    categories: Record<Category, { on: boolean; query: string }>;
  };
  defaults: Record<Category, string>;
  secrets: Record<string, "env" | "saved" | null>;
  mailbox: { email: string; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number; fromEnv: boolean } | null;
  webhook: string | null;
  link: string | null;
  imports?: {
    cdtfa: { rows: number; added: number; at: string } | null;
    sba: { url: string; offset: number; size: number; scanned: number; matched: number; added: number; status: string; finished_at: string | null } | null;
    states?: Record<string, { at: string; rows: number; added: number; error?: string }> | null;
    stateList?: Record<string, { label: string; page: string }>;
  };
}

const KEYS = [
  { name: "COURTLISTENER_API_KEY", label: "CourtListener API token", check: "courtlistener", help: "courtlistener.com → Profile → Developer tools → API token" },
  { name: "BETTERCONTACT_API_KEY", label: "BetterContact API key", check: "bettercontact", help: "app.bettercontact.rocks → API" },
  { name: "OPENAI_API_KEY", label: "OpenAI API key (optional)", check: null, help: "Helps pull owner names and debt amounts out of court text" },
  { name: "HUNTER_API_KEY", label: "Hunter.io API key (recommended)", check: null, help: "Finds verified emails from a company name or website. Free: 25 searches/month; Starter $49/month. hunter.io → API" },
  { name: "SERPER_API_KEY", label: "Serper.dev API key (recommended)", check: null, help: "Google search results to find each company's website and owner. 2,500 free searches, then about $50 per 50,000. serper.dev → API key" },
  { name: "OPENCORPORATES_API_KEY", label: "OpenCorporates API key (optional, paid)", check: null, help: "Officer names for companies in every state. Without it, NEXGEN uses the free NY, CO, CT and OR registries plus the company website." },
] as const;

function urlB64ToUint8(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type BIPEvent = Event & { prompt: () => Promise<void> };

interface SearchTest {
  ok: boolean;
  message?: string;
  days?: number;
  count?: number | null;
  kept?: number;
  sample?: { caption: string; filed?: string; kept: boolean; company: string | null; owner: string | null }[];
  searchesLeft?: number;
}

export default function SettingsPage() {
  const { toast, refresh, feed } = useFeed();
  const [v, setV] = useState<View | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [mb, setMb] = useState({ email: "", password: "", smtp_host: "", smtp_port: "", imap_host: "", imap_port: "" });
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cats, setCats] = useState<View["settings"]["categories"] | null>(null);
  const [sched, setSched] = useState({ ingest_every_min: 20, lookback_days: 2 });
  const [tests, setTests] = useState<Partial<Record<Category, SearchTest>>>({});
  const [pushState, setPushState] = useState<"unsupported" | "off" | "on" | "denied" | "needs-install">("off");
  const [installEvt, setInstallEvt] = useState<BIPEvent | null>(null);

  const load = async () => {
    const r = await api<View>("/api/settings");
    setV(r);
    setCats(r.settings.categories);
    setSched({ ingest_every_min: r.settings.ingest_every_min, lookback_days: r.settings.lookback_days });
  };

  useEffect(() => {
    load();
    const onBip = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BIPEvent);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState(ios && !standalone ? "needs-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") return setPushState("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setPushState(sub ? "on" : "off");
    })();
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const enablePush = () =>
    run("push", async () => {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState("denied");
        throw new Error("Notifications were blocked. Allow them for this site in your browser settings.");
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>("/api/push");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(publicKey) });
      await api("/api/push", { method: "POST", json: { ...sub.toJSON(), label: navigator.userAgent.slice(0, 80) } });
      setPushState("on");
      await api("/api/push/test", { method: "POST" });
    }, "Alerts on — a test notification is on its way");

  const disablePush = () =>
    run("push", async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push", { method: "DELETE", json: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setPushState("off");
    }, "Alerts off on this device");

  if (!v || !cats) return <div className="muted">Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Connections, mailbox, what to fetch, and phone alerts.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-h">
            <h2>Phone alerts & app</h2>
          </div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="sub" style={{ margin: 0 }}>
              Get a notification for new leads, contacts found and replies. Turn it on separately on each phone or computer.
            </p>
            {pushState === "needs-install" && (
              <div className="notice info">On iPhone: tap Share → Add to Home Screen, open NEXGEN from the home screen, then come back here to turn alerts on.</div>
            )}
            {pushState === "denied" && <div className="notice err">Notifications are blocked for this site. Allow them in the browser&apos;s site settings, then reload.</div>}
            {pushState === "unsupported" && <div className="notice">This browser can&apos;t show push notifications.</div>}
            <div className="row">
              {pushState === "on" ? (
                <>
                  <span className="pill green">Alerts on for this device</span>
                  <button className="btn sm" disabled={busy === "push"} onClick={() => run("test", () => api("/api/push/test", { method: "POST" }), "Test sent")}>
                    Send a test
                  </button>
                  <button className="btn sm" disabled={busy === "push"} onClick={disablePush}>
                    Turn off
                  </button>
                </>
              ) : (
                <button className="btn primary" disabled={busy === "push" || pushState === "unsupported" || pushState === "needs-install"} onClick={enablePush}>
                  Turn on alerts
                </button>
              )}
              <span className="small">{feed?.health.pushDevices ?? 0} device(s) receiving alerts</span>
            </div>
            <div className="row">
              {installEvt ? (
                <button
                  className="btn"
                  onClick={async () => {
                    await installEvt.prompt();
                    setInstallEvt(null);
                  }}
                >
                  Install NEXGEN app
                </button>
              ) : (
                <span className="small">
                  To install: Chrome/Edge — the install icon in the address bar (or menu → Install app). iPhone — Share → Add to Home Screen.
                </span>
              )}
            </div>
            {v.link && (
              <div className="field">
                <label>Your private link (opens the dashboard instantly — keep it to yourself)</label>
                <div className="row">
                  <input className="input" readOnly value={v.link} style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.target.select()} />
                  <button className="btn sm" onClick={() => navigator.clipboard.writeText(v.link!).then(() => toast("Link copied"))}>
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Mailbox</h2>
            {v.mailbox && <span className="pill green">Connected</span>}
          </div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="sub" style={{ margin: 0 }}>
              Emails go out from this mailbox and its inbox is checked every minute for replies. For Gmail use an App Password (Google Account → Security → App passwords).
            </p>
            {v.mailbox ? (
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <b>{v.mailbox.email}</b>
                  <div className="small">
                    SMTP {v.mailbox.smtp_host}:{v.mailbox.smtp_port} · IMAP {v.mailbox.imap_host}:{v.mailbox.imap_port}
                  </div>
                </div>
                {!v.mailbox.fromEnv && (
                  <button className="btn sm danger" onClick={() => run("mb", () => api("/api/settings", { method: "PUT", json: { mailbox: { remove: true } } }), "Mailbox disconnected")}>
                    Disconnect
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="mbe">Email address</label>
                    <input id="mbe" className="input" type="email" autoComplete="off" value={mb.email} onChange={(e) => setMb({ ...mb, email: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="mbp">Password / app password</label>
                    <input id="mbp" className="input" type="password" autoComplete="new-password" value={mb.password} onChange={(e) => setMb({ ...mb, password: e.target.value })} />
                  </div>
                </div>
                <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => setAdv(!adv)}>
                  {adv ? "Hide" : "Server settings (optional)"}
                </button>
                {adv && (
                  <div className="form-grid">
                    {(["smtp_host", "smtp_port", "imap_host", "imap_port"] as const).map((k) => (
                      <div className="field" key={k}>
                        <label htmlFor={k}>{k.replace("_", " ").toUpperCase()}</label>
                        <input id={k} className="input" value={mb[k]} placeholder="automatic" onChange={(e) => setMb({ ...mb, [k]: e.target.value })} />
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className="btn primary"
                  style={{ alignSelf: "flex-start" }}
                  disabled={busy === "mb" || !mb.email || !mb.password}
                  onClick={() =>
                    run("mb", async () => {
                      await api("/api/settings", { method: "PUT", json: { mailbox: mb } });
                      setMb({ email: "", password: "", smtp_host: "", smtp_port: "", imap_host: "", imap_port: "" });
                    }, "Mailbox connected")
                  }
                >
                  {busy === "mb" ? "Checking sign-in…" : "Connect mailbox"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Connections</h2>
        </div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {KEYS.map((k) => (
            <div key={k.name} className="field">
              <label htmlFor={k.name}>
                {k.label}{" "}
                {v.secrets[k.name] ? (
                  <span className="pill green" style={{ marginLeft: 6 }}>
                    {v.secrets[k.name] === "env" ? "Set on server" : "Saved"}
                  </span>
                ) : (
                  <span className="pill gray" style={{ marginLeft: 6 }}>
                    Not set
                  </span>
                )}
              </label>
              <div className="row">
                <input
                  id={k.name}
                  className="input"
                  type="password"
                  autoComplete="off"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder={v.secrets[k.name] ? "•••••••• (paste a new one to replace)" : "Paste key"}
                  value={keys[k.name] ?? ""}
                  onChange={(e) => setKeys({ ...keys, [k.name]: e.target.value })}
                />
                <button
                  className="btn"
                  disabled={!keys[k.name] || busy === k.name}
                  onClick={() =>
                    run(k.name, async () => {
                      await api("/api/settings", { method: "PUT", json: { secrets: { [k.name]: keys[k.name] } } });
                      setKeys({ ...keys, [k.name]: "" });
                    }, "Key saved")
                  }
                >
                  Save
                </button>
                {k.check && v.secrets[k.name] && (
                  <button
                    className="btn"
                    disabled={busy === `c-${k.name}`}
                    onClick={async () => {
                      setBusy(`c-${k.name}`);
                      const r = await api<{ ok: boolean; message: string }>(`/api/settings?check=${k.check}`).catch((e) => ({ ok: false, message: (e as Error).message }));
                      setChecks({ ...checks, [k.name]: `${r.ok ? "✓" : "✗"} ${r.message}` });
                      setBusy(null);
                    }}
                  >
                    Test
                  </button>
                )}
              </div>
              <span className="small">{checks[k.name] ?? k.help}</span>
            </div>
          ))}
          <div className="row" style={{ justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div>
              <b>Also find mobile numbers</b>
              <div className="small">
                Off = emails only (about 1 BetterContact credit per email found). On = also mobile numbers for WhatsApp/calls, up to 10 credits each.
              </div>
            </div>
            <button
              className={`switch ${v.settings.find_phones ? "on" : ""}`}
              aria-label="Also find mobile numbers"
              aria-pressed={v.settings.find_phones}
              onClick={() =>
                run("phones", () => api("/api/settings", { method: "PUT", json: { settings: { find_phones: !v.settings.find_phones } } }), !v.settings.find_phones ? "Mobile numbers on — up to 10 credits each" : "Emails only")
              }
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <div>
              <b>Research backfill leads too</b>
              <div className="small">On = older filings from a backfill are searched for emails as well, until credits run out. Off = only new filings.</div>
            </div>
            <button
              className={`switch ${v.settings.enrich_backfill ? "on" : ""}`}
              aria-label="Research backfill leads"
              aria-pressed={v.settings.enrich_backfill}
              onClick={() => run("bf", () => api("/api/settings", { method: "PUT", json: { settings: { enrich_backfill: !v.settings.enrich_backfill } } }), "Saved")}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <b>Individuals: minimum amount owed</b>
              <div className="small">People (not companies) in tax or debt suits are shown only when the amount on file is at least this much.</div>
            </div>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              style={{ width: 140 }}
              defaultValue={v.settings.individual_min_amount}
              onBlur={(e) => run("min", () => api("/api/settings", { method: "PUT", json: { settings: { individual_min_amount: Number(e.target.value) } } }), "Saved")}
            />
          </div>
          {v.webhook && <div className="small">BetterContact results come back to {v.webhook} (and are also polled every few minutes as a backup).</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Tax arrears &amp; bank-loan defaults</h2>
        </div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p className="sub" style={{ margin: 0 }}>
            Companies in distress that never went to court. Each one is searched for its owner&apos;s email like any other lead, and only shows once an email is found.
          </p>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <b>Tax arrears — California CDTFA Top 500</b>
              <div className="small">
                Businesses with the largest unpaid sales &amp; use tax, with the exact balance and lien date. Refreshed daily.
                {v.imports?.cdtfa ? ` Last import: ${v.imports.cdtfa.rows} businesses listed, ${v.imports.cdtfa.added} new.` : ""}
              </div>
            </div>
            <button
              className={`switch ${v.settings.source_cdtfa ? "on" : ""}`}
              aria-label="Tax arrears source"
              aria-pressed={v.settings.source_cdtfa}
              onClick={() => run("cdtfa", () => api("/api/settings", { method: "PUT", json: { settings: { source_cdtfa: !v.settings.source_cdtfa } } }), "Saved")}
            />
          </div>
          <div className="field">
            <b>Tax arrears — other states&apos; published lists</b>
            <div className="small">Checked daily. Tap a state to switch it on or off.</div>
            <div className="chips" style={{ marginTop: 6 }}>
              {Object.entries(v.imports?.stateList ?? {}).map(([code, st]) => {
                const on = v.settings.tax_states.includes(code);
                const status = v.imports?.states?.[code];
                return (
                  <button
                    key={code}
                    className={`chip ${on ? "on" : ""}`}
                    title={status ? (status.error ? `Last check failed: ${status.error}` : `${status.rows} on the list, ${status.added} new at last import`) : "Not imported yet"}
                    onClick={() =>
                      run("st-" + code, () =>
                        api("/api/settings", {
                          method: "PUT",
                          json: { settings: { tax_states: on ? v.settings.tax_states.filter((x) => x !== code) : [...v.settings.tax_states, code] } },
                        }),
                      )
                    }
                  >
                    {st.label}
                    {status && !status.error ? ` · ${status.rows}` : status?.error ? " · error" : ""}
                  </button>
                );
              })}
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              Not available automatically: Massachusetts and Rhode Island block automated access, Wisconsin and South Carolina don&apos;t answer scripts, Oregon shows its list
              only in an interactive portal, Connecticut sends it by email on request, Georgia and Louisiana stopped publishing.
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <b>Minimum unpaid tax</b>
              <div className="small">Companies owing less than this on a state list are skipped.</div>
            </div>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              style={{ width: 140 }}
              defaultValue={v.settings.tax_min_amount}
              onBlur={(e) => run("tmin", () => api("/api/settings", { method: "PUT", json: { settings: { tax_min_amount: Number(e.target.value) } } }), "Saved")}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <b>Bank-loan defaults — SBA 7(a) charge-offs</b>
              <div className="small">
                Bank loans the lender wrote off because the business stopped paying (nationwide, with bank and amount). Updated quarterly by the SBA.
                {v.imports?.sba
                  ? v.imports.sba.status === "done"
                    ? ` Last import: ${v.imports.sba.scanned.toLocaleString()} loans read, ${v.imports.sba.matched} recent charge-offs, ${v.imports.sba.added} new.`
                    : ` Reading the loan file: ${Math.round((v.imports.sba.offset / Math.max(1, v.imports.sba.size)) * 100)}% — ${v.imports.sba.added} companies so far.`
                  : ""}
              </div>
            </div>
            <button
              className={`switch ${v.settings.source_sba ? "on" : ""}`}
              aria-label="Bank-loan defaults source"
              aria-pressed={v.settings.source_sba}
              onClick={() => run("sba", () => api("/api/settings", { method: "PUT", json: { settings: { source_sba: !v.settings.source_sba } } }), "Saved")}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
            <div>
              <b>Charge-offs from the last (months)</b>
              <div className="small">Older write-offs are more likely to be closed businesses.</div>
            </div>
            <input
              className="input"
              type="number"
              min={1}
              max={72}
              style={{ width: 100 }}
              defaultValue={v.settings.sba_months}
              onBlur={(e) => run("months", () => api("/api/settings", { method: "PUT", json: { settings: { sba_months: Number(e.target.value) } } }), "Saved")}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>What to fetch</h2>
          <button
            className="btn primary sm"
            disabled={busy === "cats"}
            onClick={() => run("cats", () => api("/api/settings", { method: "PUT", json: { settings: { categories: cats, ...sched } } }), "Saved — next court check uses these")}
          >
            Save
          </button>
        </div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="every">Check the courts every (minutes)</label>
              <input id="every" className="input" type="number" min={1} max={1440} value={sched.ingest_every_min} onChange={(e) => setSched({ ...sched, ingest_every_min: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="lb">Only filings from the last (days)</label>
              <input id="lb" className="input" type="number" min={1} max={60} value={sched.lookback_days} onChange={(e) => setSched({ ...sched, lookback_days: Number(e.target.value) })} />
            </div>
          </div>
          {CATS.map((c) => (
            <div key={c} className="field">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <label htmlFor={`q-${c}`} style={{ fontSize: 14, color: "var(--ink)" }}>
                  {CAT_LABEL[c]} leads
                  <span className="small" style={{ fontWeight: 400, marginLeft: 8 }}>
                    {c === "court" ? "Business bankruptcy filings (Chapter 11, Subchapter V)" : c === "tax" ? "Federal tax suits against businesses" : "Commercial debt and collection suits against businesses"}
                  </span>
                </label>
                <button
                  className={`switch ${cats[c].on ? "on" : ""}`}
                  aria-label={`Fetch ${CAT_LABEL[c]}`}
                  aria-pressed={cats[c].on}
                  onClick={() => setCats({ ...cats, [c]: { ...cats[c], on: !cats[c].on } })}
                />
              </div>
              <textarea id={`q-${c}`} className="textarea" style={{ minHeight: 60, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={cats[c].query} onChange={(e) => setCats({ ...cats, [c]: { ...cats[c], query: e.target.value } })} />
              <div className="row">
                <button
                  className="btn sm"
                  disabled={busy === `t-${c}`}
                  onClick={async () => {
                    setBusy(`t-${c}`);
                    const p = new URLSearchParams({ check: "query", cat: c, q: cats[c].query, days: String(sched.lookback_days) });
                    const r = await api<SearchTest>(`/api/settings?${p}`).catch((e) => ({ ok: false, message: (e as Error).message }) as SearchTest);
                    setTests({ ...tests, [c]: r });
                    setBusy(null);
                  }}
                >
                  {busy === `t-${c}` ? "Searching…" : "Test search"}
                </button>
                {cats[c].query !== v.defaults[c] && (
                  <button className="btn sm" onClick={() => setCats({ ...cats, [c]: { ...cats[c], query: v.defaults[c] } })}>
                    Reset to default
                  </button>
                )}
              </div>
              {tests[c] && (
                <div className="notice info" style={{ fontSize: 12 }}>
                  {tests[c]!.ok ? (
                    <>
                      <b>
                        {tests[c]!.count ?? 0} filings in the last {tests[c]!.days} days match; {tests[c]!.kept} of the newest {tests[c]!.sample?.length ?? 0} pass the
                        distressed-business check.
                      </b>
                      {(tests[c]!.sample ?? []).slice(0, 8).map((x, i) => (
                        <div key={i}>
                          {x.kept ? "✓" : "✗"} {x.caption}
                          {x.kept && x.owner ? ` — owner: ${x.owner}` : ""}
                        </div>
                      ))}
                    </>
                  ) : (
                    tests[c]!.message
                  )}
                  {typeof tests[c]!.searchesLeft === "number" && <div className="small">{tests[c]!.searchesLeft} CourtListener searches left this hour.</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
