"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeed } from "@/components/feed";
import { api, daysSince, type Lead } from "@/components/util";

type Tid = "initial" | "followup";
interface Tpl {
  id: Tid;
  subject: string;
  body: string;
}

const VARS = ["first_name", "full_name", "company_name", "debt_amount", "distress_type", "days_in_distress", "case_number", "court_name", "sender_name"];

function render(t: string, l: Lead | undefined, sender: string) {
  const v: Record<string, string> = {
    first_name: l?.founder_full_name?.split(" ")[0] || "there",
    full_name: l?.founder_full_name || "",
    company_name: l?.company_name || "Acme Logistics LLC",
    debt_amount: l?.debt_amount_text || "the outstanding balance",
    distress_type: l?.distress_type || "Chapter 11 — Subchapter V",
    days_in_distress: String(daysSince(l?.filing_date ?? null) ?? 12),
    case_number: l?.case_number || "",
    court_name: l?.court_name || "",
    sender_name: sender,
  };
  return t.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in v ? v[k] : m));
}

export default function OutreachPage() {
  const { feed, toast, refresh } = useFeed();
  const [tpl, setTpl] = useState<Record<Tid, Tpl> | null>(null);
  const [tab, setTab] = useState<Tid>("initial");
  const [sender, setSender] = useState({ sender_name: "", physical_address: "" });
  const [rules, setRules] = useState({ send_gap_min: 2, daily_limit: 50, auto_followup_days: 0 });
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");

  useEffect(() => {
    api<{ initial: Tpl; followup: Tpl; sender_name: string; physical_address: string }>("/api/templates").then((r) => {
      setTpl({ initial: r.initial, followup: r.followup });
      setSender({ sender_name: r.sender_name, physical_address: r.physical_address });
    });
    api<{ settings: { send_gap_min: number; daily_limit: number; auto_followup_days: number } }>("/api/settings").then((r) =>
      setRules({ send_gap_min: r.settings.send_gap_min, daily_limit: r.settings.daily_limit, auto_followup_days: r.settings.auto_followup_days }),
    );
  }, []);

  const sample = useMemo(() => feed?.leads.find((l) => l.direct_email && l.founder_full_name) ?? feed?.leads.find((l) => l.founder_full_name) ?? feed?.leads[0], [feed?.leads]);
  const auto = feed?.settings.auto_send ?? false;

  const toggleAuto = async () => {
    try {
      await api("/api/settings", { method: "PUT", json: { settings: { auto_send: !auto } } });
      toast(!auto ? "Auto-send is ON — every new lead with a verified email gets the new-lead email once" : "Auto-send is OFF");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const insert = (v: string) => {
    if (!tpl) return;
    const token = `{{${v}}}`;
    const cur = tpl[tab];
    if (lastFocus.current === "subject" && subjRef.current) {
      const el = subjRef.current;
      const s = el.selectionStart ?? cur.subject.length;
      const next = cur.subject.slice(0, s) + token + cur.subject.slice(el.selectionEnd ?? s);
      setTpl({ ...tpl, [tab]: { ...cur, subject: next } });
      requestAnimationFrame(() => el.setSelectionRange(s + token.length, s + token.length));
    } else if (bodyRef.current) {
      const el = bodyRef.current;
      const s = el.selectionStart ?? cur.body.length;
      const next = cur.body.slice(0, s) + token + cur.body.slice(el.selectionEnd ?? s);
      setTpl({ ...tpl, [tab]: { ...cur, body: next } });
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(s + token.length, s + token.length);
      });
    }
  };

  const save = async () => {
    if (!tpl) return;
    setSaving(true);
    try {
      await api("/api/templates", { method: "PUT", json: tpl.initial });
      await api("/api/templates", { method: "PUT", json: tpl.followup });
      await api("/api/settings", { method: "PUT", json: { settings: { ...sender, ...rules } } });
      toast("Saved");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  if (!tpl || !feed) return <div className="muted">Loading…</div>;
  const cur = tpl[tab];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Outreach</h1>
          <p>Two emails: the new-lead email (sent once per person, ever) and the follow-up.</p>
        </div>
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      <div className="card">
        <div className="card-b" style={{ paddingTop: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <h2>Automatic sending</h2>
              <p className="sub" style={{ margin: "4px 0 0" }}>
                When on, every lead that gets a verified email is sent the new-lead email automatically — never twice.
              </p>
            </div>
            <button className={`switch ${auto ? "on" : ""}`} onClick={toggleAuto} aria-label="Auto-send" aria-pressed={auto} />
          </div>
          {auto && !feed.health.mailbox && <div className="notice err">Auto-send is on but no mailbox is connected, so nothing can go out. Connect one in Settings.</div>}
          <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
            <div className="field">
              <label htmlFor="gap">Minutes between emails</label>
              <input id="gap" className="input" type="number" min={0} max={1440} value={rules.send_gap_min} onChange={(e) => setRules({ ...rules, send_gap_min: Number(e.target.value) })} />
              <span className="small">1–3 keeps your inbox reputation healthy. 0 sends as fast as possible.</span>
            </div>
            <div className="field">
              <label htmlFor="cap">Daily limit</label>
              <input id="cap" className="input" type="number" min={1} max={2000} value={rules.daily_limit} onChange={(e) => setRules({ ...rules, daily_limit: Number(e.target.value) })} />
              <span className="small">{feed.stats.sent_24h} sent in the last 24 hours.</span>
            </div>
            <div className="field">
              <label htmlFor="fu">Auto follow-up after (days)</label>
              <input id="fu" className="input" type="number" min={0} max={60} value={rules.auto_followup_days} onChange={(e) => setRules({ ...rules, auto_followup_days: Number(e.target.value) })} />
              <span className="small">0 = off. Only for leads who haven't replied.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-h">
            <div className="tabs">
              <button className={tab === "initial" ? "on" : ""} onClick={() => setTab("initial")}>
                New-lead email
              </button>
              <button className={tab === "followup" ? "on" : ""} onClick={() => setTab("followup")}>
                Follow-up email
              </button>
            </div>
          </div>
          <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field">
              <label>Insert a field</label>
              <div className="vars">
                {VARS.map((v) => (
                  <button key={v} className="var" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v)}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="subj">Subject</label>
              <input
                id="subj"
                ref={subjRef}
                className="input"
                value={cur.subject}
                onFocus={() => (lastFocus.current = "subject")}
                onChange={(e) => setTpl({ ...tpl, [tab]: { ...cur, subject: e.target.value } })}
              />
            </div>
            <div className="field">
              <label htmlFor="body">Message</label>
              <textarea
                id="body"
                ref={bodyRef}
                className="textarea"
                style={{ minHeight: 300 }}
                value={cur.body}
                onFocus={() => (lastFocus.current = "body")}
                onChange={(e) => setTpl({ ...tpl, [tab]: { ...cur, body: e.target.value } })}
              />
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="sn">Your name (sender)</label>
                <input id="sn" className="input" value={sender.sender_name} onChange={(e) => setSender({ ...sender, sender_name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="addr">Mailing address (shown in the footer)</label>
                <input id="addr" className="input" value={sender.physical_address} onChange={(e) => setSender({ ...sender, physical_address: e.target.value })} />
              </div>
            </div>
            {!sender.physical_address && <div className="notice">US anti-spam law (CAN-SPAM) expects a postal address in commercial email footers.</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Preview</h2>
            <span className="small">{sample ? `as sent to ${sample.company_name}` : "sample lead"}</span>
          </div>
          <div className="card-b">
            <div className="preview">
              <div className="small">To: {sample?.direct_email ?? "owner@company.com"}</div>
              <div className="subj">{render(cur.subject, sample, sender.sender_name)}</div>
              <pre>{render(cur.body, sample, sender.sender_name)}</pre>
              <div className="foot">
                {sender.physical_address && (
                  <>
                    {sender.physical_address}
                    <br />
                  </>
                )}
                Don&apos;t want these emails? <u>Unsubscribe</u>
              </div>
            </div>
            <p className="small" style={{ marginTop: 10 }}>
              From: {sender.sender_name ? `${sender.sender_name} <${feed.health.mailbox ?? "your mailbox"}>` : feed.health.mailbox ?? "your mailbox (not connected)"}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
