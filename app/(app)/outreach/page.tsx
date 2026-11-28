"use client";

import { Skeleton } from "@/components/Skeleton";
import { useEffect, useState } from "react";
import { useFeed } from "@/components/feed";
import { TemplateBuilder } from "@/components/TemplateBuilder";
import { api, CAT_COLOR, CAT_LABEL, CATS, type Category } from "@/components/util";

export default function OutreachPage() {
  const { feed, toast, refresh } = useFeed();
  const [cat, setCat] = useState<Category>("court");
  const [rules, setRules] = useState({ send_gap_min: 2, daily_limit: 50, auto_followup_days: 0, sender_name: "", physical_address: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ settings: typeof rules }>("/api/settings").then((r) =>
      setRules({
        send_gap_min: r.settings.send_gap_min,
        daily_limit: r.settings.daily_limit,
        auto_followup_days: r.settings.auto_followup_days,
        sender_name: r.settings.sender_name,
        physical_address: r.settings.physical_address,
      }),
    );
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/settings", { method: "PUT", json: { settings: rules } });
      toast("Sending rules saved");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  if (!feed) return <Skeleton />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Outreach</h1>
          <p>Each category has its own email and its own Auto-Send switch. A lead gets the new-lead email once — never twice.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Sending rules (all categories)</h2>
          <button className="btn primary sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
            <div className="field">
              <label htmlFor="gap">Minutes between emails</label>
              <input id="gap" className="input" type="number" min={0} max={1440} value={rules.send_gap_min} onChange={(e) => setRules({ ...rules, send_gap_min: Number(e.target.value) })} />
              <span className="small">1–3 keeps inbox placement healthy. 0 = as fast as possible.</span>
            </div>
            <div className="field">
              <label htmlFor="cap">Daily limit</label>
              <input id="cap" className="input" type="number" min={1} max={2000} value={rules.daily_limit} onChange={(e) => setRules({ ...rules, daily_limit: Number(e.target.value) })} />
              <span className="small">{feed.stats.sent_24h} sent in the last 24 hours.</span>
            </div>
            <div className="field">
              <label htmlFor="fu">Auto follow-up after (days)</label>
              <input id="fu" className="input" type="number" min={0} max={60} value={rules.auto_followup_days} onChange={(e) => setRules({ ...rules, auto_followup_days: Number(e.target.value) })} />
              <span className="small">0 = off. Uses each category&apos;s follow-up email.</span>
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="sn">Your name (sender)</label>
              <input id="sn" className="input" value={rules.sender_name} onChange={(e) => setRules({ ...rules, sender_name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="addr">Mailing address (email footer)</label>
              <input id="addr" className="input" value={rules.physical_address} onChange={(e) => setRules({ ...rules, physical_address: e.target.value })} />
            </div>
          </div>
          {!rules.physical_address && <div className="notice">US anti-spam law (CAN-SPAM) expects a postal address in commercial email footers.</div>}
          {!feed.health.mailbox && <div className="notice err">No mailbox connected yet, so nothing can go out. Connect one in Settings.</div>}
        </div>
      </div>

      <div className="tabs" style={{ alignSelf: "flex-start" }}>
        {CATS.map((c) => (
          <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
            <span className="cat">
              <i style={{ background: CAT_COLOR[c] }} />
            </span>
            {CAT_LABEL[c]}
            <span className={`pill ${feed.settings.categories[c]?.auto_send ? "green" : "gray"}`} style={{ height: 18, fontSize: 11 }}>
              {feed.settings.categories[c]?.auto_send ? "Auto ON" : "Auto off"}
            </span>
          </button>
        ))}
      </div>
      <TemplateBuilder key={cat} category={cat} />
    </>
  );
}
