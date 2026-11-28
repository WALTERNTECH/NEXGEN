"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFeed } from "./feed";
import { api, CAT_LABEL, CAT_NAME, type Category, type Lead } from "./util";
import { FIELDS, render, rawVars, missingFor, unknownTokens } from "@/lib/render";

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
  defaults: Record<Category, Record<Kind, { subject: string; body: string }>>;
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
  const [testTo, setTestTo] = useState("info@kryptoninvestments.online");
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem("nx_test_to");
    if (v) setTestTo(v);
  }, []);
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

  // The preview flips through this category's real leads, so you can see each one gets its own details.
  const samples: Lead[] = useMemo(() => {
    const inCat = (feed?.leads ?? []).filter((l) => l.category === category);
    const withEmail = inCat.filter((l) => l.direct_email);
    return withEmail.length ? withEmail : inCat;
  }, [feed?.leads, category]);
  const [pick, setPick] = useState(0);
  const sample: Lead | undefined = samples.length ? samples[pick % samples.length] : undefined;

  if (!data || !draft || !feed) return <div className="card card-b muted">Loading email builder…</div>;
  const t = data.templates[category];
  const cur = draft[kind];
  const saved = t[kind].saved && t[kind].subject === cur.subject && t[kind].body === cur.body;
  const auto = feed.settings.categories[category]?.auto_send ?? false;
  const initialSaved = t.initial.saved;
  const sender = data.sender_name;
  const eligible = feed.leads.filter((l) => l.category === category && l.status === "enriched" && l.direct_email && !l.auto_email_sent && !l.queued).length;

  const restore = () => {
    if (!confirm("Replace this draft with NEXGEN's starting draft? (Nothing is saved until you press Save.)")) return;
    setDraft({ ...draft, [kind]: { ...data.defaults[category][kind] } });
  };

  // Wrap the selected text in [[ ]] so it's left out for leads that don't have a detail used inside it.
  const optional = () => {
    const el = lastFocus.current === "subject" ? subjRef.current : bodyRef.current;
    const field = lastFocus.current === "subject" ? "subject" : "body";
    const text = cur[field];
    const a = el?.selectionStart ?? 0;
    const b = el?.selectionEnd ?? 0;
    if (a === b) {
      toast("Select the sentence first, then press this", true);
      return;
    }
    setDraft({ ...draft, [kind]: { ...cur, [field]: text.slice(0, a) + "[[" + text.slice(a, b) + "]]" + text.slice(b) } });
  };

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

  // A test goes to your own address, filled with made-up sample details — never a real lead.
  const sendTest = async () => {
    setTesting(true);
    try {
      localStorage.setItem("nx_test_to", testTo);
      await api("/api/templates", { method: "POST", json: { category, subject: cur.subject, body: cur.body, to: testTo } });
      toast(`Test sent to ${testTo} — filled with sample details`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setTesting(false);
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
          <p className="small" style={{ margin: 0 }}>
            Write the email once and put a placeholder like <code>{"{{company_name}}"}</code> wherever a lead&apos;s own detail should go. When each email is sent, NEXGEN swaps every
            placeholder for <b>that lead&apos;s exact value</b> — nothing else in your text is read or changed. Tap a detail to insert it at your cursor, or type it yourself.
          </p>
          <div className="vars">
            {FIELDS.filter((f) => !f.cats || f.cats.includes(category)).map((f) => {
              const val = sample ? rawVars(sample, sender)[f.key] : "";
              return (
                <button
                  key={f.key}
                  className="var"
                  title={`${f.label}${val ? ` — e.g. ${val}` : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(f.token)}
                >
                  <span className="var-l">{f.label}</span> <code>{`{{${f.token}}}`}</code>
                </button>
              );
            })}
            <button className="var opt" onMouseDown={(e) => e.preventDefault()} onClick={optional} title="Wrap the selected sentence in [[ ]]">
              [[ Leave out if missing ]]
            </button>
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
          {(() => {
            const unknown = [...new Set([...unknownTokens(cur.subject), ...unknownTokens(cur.body)])];
            return unknown.length ? (
              <div className="notice">
                Not recognised: <b>{unknown.join(", ")}</b> — these would stay as typed. Use a placeholder from the list above (capitals and spaces don&apos;t matter).
              </div>
            ) : null;
          })()}
          {!saved && (
            <div className="notice">
              <b>Not saved.</b> Emails use only the <b>saved</b> version{t[kind].saved ? "" : " — nothing is saved yet, so NEXGEN's starting draft is used"}. Press Save when you&apos;re done.
            </div>
          )}
          <details className="guide">
            <summary>Placeholder guide — every detail NEXGEN can fill in</summary>
            <p className="small">
              Type a placeholder in double curly braces. Capitals, spaces and dashes don&apos;t matter: <code>{"{{Company Name}}"}</code> works the same as{" "}
              <code>{"{{company_name}}"}</code>. Wrap a sentence in <code>[[ ]]</code> to drop it for leads that don&apos;t have that detail, e.g.{" "}
              <code>{"[[The balance is {{amount_owed}}.]]"}</code>
            </p>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Type this</th>
                  <th>Fills in</th>
                  <th>{sample ? `For ${sample.company_name}` : "Example"}</th>
                  <th>Also works</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>
                      <code>{`{{${f.token}}}`}</code>
                    </td>
                    <td>{f.label}</td>
                    <td>{sample ? rawVars(sample, sender)[f.key] || <span className="muted">— not on record</span> : ""}</td>
                    <td className="small">{f.also.slice(0, 4).map((a) => `{{${a}}}`).join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <div className="row">
            <button className="btn primary" onClick={save} disabled={saving || saved}>
              {saving ? "Saving…" : saved ? "Saved" : `Save ${kind === "initial" ? "new-lead" : "follow-up"} email`}
            </button>
            <button className="btn ghost" onClick={restore}>
              Restore starting draft
            </button>
            {auto && kind === "initial" && <span className="small">Saved changes apply to the next emails that go out.</span>}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input
              className="input"
              style={{ maxWidth: 280 }}
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              aria-label="Send a test to this address"
            />
            <button className="btn" onClick={sendTest} disabled={testing || !testTo}>
              {testing ? "Sending…" : "Send test"}
            </button>
            <span className="small">Sends this draft, filled with made-up sample details (Sample Test Company LLC, $50,000), to your test address. No lead is used.</span>
          </div>
        </div>
        <div>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <div className="section-t" style={{ margin: 0 }}>Preview {sample ? `— as ${sample.company_name} will get it` : "— sample lead"}</div>
            {samples.length > 1 && (
              <div className="row" style={{ gap: 4 }}>
                <button className="btn ghost sm" onClick={() => setPick((pick - 1 + samples.length) % samples.length)} aria-label="Previous lead">
                  ‹
                </button>
                <span className="small">
                  lead {(pick % samples.length) + 1} of {samples.length}
                </span>
                <button className="btn ghost sm" onClick={() => setPick(pick + 1)} aria-label="Next lead">
                  ›
                </button>
              </div>
            )}
          </div>
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
          {sample && (() => {
            const miss = [...new Set([...missingFor(cur.subject, sample, sender), ...missingFor(cur.body, sample, sender)])].filter((k) => k !== "sender_name");
            return miss.length ? (
              <p className="small" style={{ color: "var(--warn, #b45309)" }}>
                This lead has no {miss.map((k) => FIELDS.find((f) => f.key === k)?.label.toLowerCase() ?? k).join(", ")} on record — a neutral phrase is used instead. Wrap that sentence in [[ ]] to leave it out.
              </p>
            ) : null;
          })()}
          {!sender && <p className="small">Add your name and mailing address on the Outreach page so {"{{your_name}}"} and the footer fill in.</p>}
        </div>
      </div>
    </div>
  );
}
