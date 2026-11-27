"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeed } from "./feed";
import { api, CAT_LABEL, CAT_NAME, type Category, type Lead } from "./util";
import { PLACEHOLDERS, render } from "@/lib/render";

type Kind = "initial" | "followup";
interface Tpl {
  kind: Kind;
  category: Category;
  subject: string;
  body: string;
  saved: boolean;
  updated_at?: string | null;
}
interface TplResp {
  templates: Record<Category, { initial: Tpl; followup: Tpl; auto_send: boolean }>;
  sender_name: string;
  physical_address: string;
}

/** Update B: one email builder per category, with that category's own Auto-Send switch. */
export function TemplateBuilder({ category, compact = false }: { category: Category; compact?: boolean }) {
  const { feed, toast, refresh } = useFeed();
  const [data, setData] = useState<TplResp | null>(null);
  const [kind, setKind] = useState<Kind>("initial");
  const [draft, setDraft] = useState<Record<Kind, { subject: string; body: string }> | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");

  const load = () =>
    api<TplResp>("/api/templates").then((r) => {
      setData(r);
      const t = r.templates[category];
      setDraft({ initial: { subject: t.initial.subject, body: t.initial.body }, followup: { subject: t.followup.subject, body: t.followup.body } });
    });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const sample: Lead | undefined = useMemo(() => {
    const inCat = (feed?.leads ?? []).filter((l) => l.category === category);
    return inCat.find((l) => l.direct_email && l.founder_full_name) ?? inCat.find((l) => l.founder_full_name) ?? inCat[0];
  }, [feed?.leads, category]);

  if (!data || !draft || !feed) return <div className="card card-b muted">Loading email builder…</div>;
  const t = data.templates[category];
  const cur = draft[kind];
  const saved = t[kind].saved && t[kind].subject === cur.subject && t[kind].body === cur.body;
  const auto = feed.settings.categories[category]?.auto_send ?? false;
  const initialSaved = t.initial.saved;
  const sender = data.sender_name;
  const eligible = feed.leads.filter((l) => l.category === category && l.status === "enriched" && l.direct_email && !l.auto_email_sent && !l.queued).length;

  const insert = (v: string) => {
    const token = `{{${v}}}`;
    const el = lastFocus.current === "subject" ? subjRef.current : bodyRef.current;
    const field = lastFocus.current === "subject" ? "subject" : "body";
    const text = cur[field];
    const s = el?.selectionStart ?? text.length;
    const e = el?.selectionEnd ?? s;
    setDraft({ ...draft, [kind]: { ...cur, [field]: text.slice(0, s) + token + text.slice(e) } });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/templates", { method: "PUT", json: { kind, category, ...cur } });
      toast(`${CAT_LABEL[category]} ${kind === "initial" ? "new-lead" : "follow-up"} email saved`);
      await load();
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const toggleAuto = async () => {
    try {
      await api("/api/settings", { method: "PUT", json: { settings: { categories: { [category]: { auto_send: !auto } } } } });
      toast(!auto ? `${CAT_LABEL[category]} Auto-Send ON — ${eligible} enriched lead${eligible === 1 ? "" : "s"} will get this email, once each` : `${CAT_LABEL[category]} Auto-Send OFF`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="card">
      <div className="card-h" style={{ flexWrap: "wrap" }}>
        <div>
          <h2>{CAT_NAME[category]} — email builder</h2>
          <div className="small">
            {initialSaved ? `New-lead email saved ${t.initial.updated_at ? new Date(t.initial.updated_at).toLocaleDateString() : ""}` : "Not saved yet — this is a starting draft"}
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="small" style={{ textAlign: "right" }}>
            Auto-Send {CAT_LABEL[category]}
            <br />
            {auto ? <b style={{ color: "var(--good)" }}>ON</b> : initialSaved ? "OFF" : "save the email first"}
          </span>
          <button className={`switch ${auto ? "on" : ""}`} onClick={toggleAuto} disabled={!initialSaved && !auto} aria-label={`Auto-Send ${CAT_LABEL[category]}`} aria-pressed={auto} />
        </div>
      </div>
      <div className="card-b" style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "minmax(0,1.1fr) minmax(0,1fr)", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="tabs" style={{ alignSelf: "flex-start" }}>
            <button className={kind === "initial" ? "on" : ""} onClick={() => setKind("initial")}>
              New-lead email {t.initial.saved ? "✓" : ""}
            </button>
            <button className={kind === "followup" ? "on" : ""} onClick={() => setKind("followup")}>
              Follow-up {t.followup.saved ? "✓" : ""}
            </button>
          </div>
          <div className="vars">
            {PLACEHOLDERS.map((v) => (
              <button key={v} className="var" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v)}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor={`subj-${category}`}>Subject</label>
            <input
              id={`subj-${category}`}
              ref={subjRef}
              className="input"
              value={cur.subject}
              onFocus={() => (lastFocus.current = "subject")}
              onChange={(e) => setDraft({ ...draft, [kind]: { ...cur, subject: e.target.value } })}
            />
          </div>
          <div className="field">
            <label htmlFor={`body-${category}`}>Message</label>
            <textarea
              id={`body-${category}`}
              ref={bodyRef}
              className="textarea"
              style={{ minHeight: 240 }}
              value={cur.body}
              onFocus={() => (lastFocus.current = "body")}
              onChange={(e) => setDraft({ ...draft, [kind]: { ...cur, body: e.target.value } })}
            />
          </div>
          <div className="row">
            <button className="btn primary" onClick={save} disabled={saving || saved}>
              {saving ? "Saving…" : saved ? "Saved" : `Save ${kind === "initial" ? "new-lead" : "follow-up"} email`}
            </button>
            {auto && kind === "initial" && <span className="small">Saved changes apply to the next emails that go out.</span>}
          </div>
        </div>
        <div>
          <div className="section-t">Preview {sample ? `— as sent to ${sample.company_name}` : "— sample lead"}</div>
          <div className="preview">
            <div className="small">To: {sample?.direct_email ?? "owner@company.com"}</div>
            <div className="subj">{render(cur.subject, sample ?? { company_name: "Acme Logistics LLC" }, sender)}</div>
            <pre>{render(cur.body, sample ?? { company_name: "Acme Logistics LLC" }, sender)}</pre>
            <div className="foot">
              {data.physical_address && (
                <>
                  {data.physical_address}
                  <br />
                </>
              )}
              Don&apos;t want these emails? <u>Unsubscribe</u>
            </div>
          </div>
          {!sender && <p className="small">Add your name and mailing address on the Outreach page so {"{{sender_name}}"} and the footer fill in.</p>}
        </div>
      </div>
    </div>
  );
}
