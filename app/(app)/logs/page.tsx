"use client";

import { useCallback, useEffect, useState } from "react";
import { useFeed } from "@/components/feed";
import { api, fmtTime } from "@/components/util";

interface Run {
  id: number;
  kind: string;
  ok: boolean;
  summary: string;
  created_at: string;
}
interface Mail {
  id: string;
  kind: string;
  recipient_email: string;
  subject: string | null;
  status: string;
  origin: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  company_name: string;
  lead_id: string;
}

const KINDS = [
  ["all", "Everything"],
  ["ingest", "Court checks"],
  ["enrich", "Contact search"],
  ["webhook", "BetterContact callbacks"],
  ["send", "Emails"],
  ["inbox", "Replies"],
  ["system", "System"],
] as const;

const KIND_LABEL: Record<string, string> = { ingest: "Courts", enrich: "Contacts", webhook: "Callback", send: "Email", inbox: "Reply", system: "System" };
const STATUS_TONE: Record<string, string> = { sent: "green", queued: "amber", sending: "amber", failed: "red", cancelled: "gray" };

export default function LogsPage() {
  const { openLead, feed } = useFeed();
  const [kind, setKind] = useState<string>("all");
  const [view, setView] = useState<"runs" | "emails">("runs");
  const [d, setD] = useState<{ runs: Run[]; emails: Mail[]; dedupe: { addresses: number; initial_sent: number; dupes: number } } | null>(null);

  const load = useCallback(() => api<typeof d>(`/api/logs?kind=${kind}`).then(setD).catch(() => {}), [kind]);
  useEffect(() => {
    load();
  }, [load, feed?.now]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>Every court check, contact search, BetterContact callback and email, newest first.</p>
        </div>
      </div>

      {d && (
        <div className={`notice ${d.dedupe.dupes ? "err" : "ok"}`}>
          {d.dedupe.dupes
            ? `${d.dedupe.dupes} address(es) received the new-lead email more than once — check below.`
            : `Zero duplicates: ${d.dedupe.initial_sent} new-lead emails went to ${d.dedupe.addresses} different addresses. The database refuses a second new-lead email to any address.`}
        </div>
      )}

      <div className="toolbar">
        <div className="tabs">
          <button className={view === "runs" ? "on" : ""} onClick={() => setView("runs")}>
            Activity log
          </button>
          <button className={view === "emails" ? "on" : ""} onClick={() => setView("emails")}>
            Email ledger
          </button>
        </div>
        {view === "runs" && (
          <select className="select" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="card">
        {!d ? (
          <div className="empty muted">Loading…</div>
        ) : view === "runs" ? (
          d.runs.length === 0 ? (
            <div className="empty">
              <b>Nothing yet</b>Activity appears after the first sync.
            </div>
          ) : (
            d.runs.map((r) => (
              <div className="log-row" key={r.id}>
                <span className="small">{fmtTime(r.created_at)}</span>
                <span>
                  <span className={`pill ${r.ok ? "gray" : "red"}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                </span>
                <span>{r.summary}</span>
              </div>
            ))
          )
        ) : d.emails.length === 0 ? (
          <div className="empty">
            <b>No emails yet</b>
          </div>
        ) : (
          d.emails.map((m) => (
            <div className="log-row" key={m.id} style={{ cursor: "pointer" }} onClick={() => openLead(m.lead_id)}>
              <span className="small">{fmtTime(m.sent_at ?? m.created_at)}</span>
              <span>
                <span className={`pill ${STATUS_TONE[m.status] ?? "gray"}`}>{m.status}</span>
              </span>
              <span>
                <b>{m.kind === "initial" ? "New-lead email" : m.kind === "followup" ? "Follow-up" : "Reply"}</b> → {m.recipient_email}{" "}
                <span className="muted">· {m.company_name}{m.origin ? ` · ${m.origin}` : ""}</span>
                {m.error && <div className="small" style={{ color: "var(--bad)" }}>{m.error}</div>}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
