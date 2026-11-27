"use client";

import { useCallback, useEffect, useState } from "react";
import { useFeed } from "./feed";
import { IX, IMail, IPhone, IWhatsApp, ILinkedIn, IExternal, IUserSearch, IReply } from "./icons";
import { api, CAT_COLOR, CAT_LABEL, contactState, daysSince, fmtDate, fmtTime, prettyPhone, telHref, waNumber, type Lead } from "./util";

interface EmailRow {
  id: string;
  kind: "initial" | "followup" | "reply";
  recipient_email: string;
  subject: string | null;
  body: string | null;
  status: string;
  origin: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}
interface ReplyRow {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body: string | null;
  received_at: string;
  is_read: boolean;
}
interface Detail {
  lead: Lead;
  emails: EmailRow[];
  replies: ReplyRow[];
}

const KIND: Record<string, string> = { initial: "New-lead email", followup: "Follow-up", reply: "Your reply" };

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast, refresh } = useFeed();
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ founder_full_name: "", founder_title: "", direct_email: "", direct_mobile: "", company_domain: "" });
  const [reply, setReply] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/leads/${id}`);
      setD(r);
      setForm({
        founder_full_name: r.lead.founder_full_name ?? "",
        founder_title: r.lead.founder_title ?? "",
        direct_email: r.lead.direct_email ?? "",
        direct_mobile: r.lead.direct_mobile ?? "",
        company_domain: r.lead.company_domain ?? "",
      });
      if (r.replies.some((x) => !x.is_read)) api(`/api/leads/${id}`, { method: "POST", json: { action: "read" } }).catch(() => {});
    } catch (e) {
      toast((e as Error).message, true);
      onClose();
    }
  }, [id, toast, onClose]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", esc);
    };
  }, [load, onClose]);

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try {
      const r = (await fn()) as Partial<Detail> | undefined;
      if (r && r.lead) setD(r as Detail);
      else await load();
      if (ok) toast(ok);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  if (!d)
    return (
      <>
        <div className="scrim" onClick={onClose} />
        <aside className="drawer">
          <div className="drawer-b muted">Loading…</div>
        </aside>
      </>
    );

  const l = d.lead;
  const st = contactState(l);
  const days = daysSince(l.filing_date);
  const thread = [
    ...d.emails.map((e) => ({ t: e.sent_at ?? e.created_at, e })),
    ...d.replies.map((r) => ({ t: r.received_at, r })),
  ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const canFind = (l.status === "enrichment_failed" || l.status === "discovered") && Boolean(l.founder_full_name?.includes(" "));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={l.company_name}>
        <div className="drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="cat">
                <i style={{ background: CAT_COLOR[l.category] }} />
                {CAT_LABEL[l.category]}
              </span>
              <span className={`pill ${st.tone}`}>{st.label}</span>
            </div>
            <h2>{l.company_name}</h2>
            <div className="small" style={{ marginTop: 2 }}>
              {l.distress_type} · filed {fmtDate(l.filing_date, true)}
              {days !== null ? ` · ${days} day${days === 1 ? "" : "s"} in distress` : ""}
            </div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <IX />
          </button>
        </div>

        <div className="drawer-b">
          <div className="bigacts">
            <a className={`bigact ${l.direct_email ? "" : "off"}`} href={l.direct_email ? `mailto:${l.direct_email}` : undefined}>
              <IMail />
              Email
            </a>
            <a className={`bigact ${l.direct_mobile ? "" : "off"}`} href={l.direct_mobile ? telHref(l.direct_mobile) : undefined}>
              <IPhone />
              Call
            </a>
            <a
              className={`bigact ${l.direct_mobile ? "" : "off"}`}
              href={l.direct_mobile ? `https://wa.me/${waNumber(l.direct_mobile)}` : undefined}
              target="_blank"
              rel="noreferrer"
            >
              <IWhatsApp />
              WhatsApp
            </a>
            <a className={`bigact ${l.linkedin_url ? "" : "off"}`} href={l.linkedin_url ?? undefined} target="_blank" rel="noreferrer">
              <ILinkedIn />
              LinkedIn
            </a>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="section-t" style={{ margin: 0 }}>
                Owner / decision maker
              </div>
              <button className="btn sm" onClick={() => setEdit((v) => !v)}>
                {edit ? "Cancel" : "Edit"}
              </button>
            </div>
            {!edit ? (
              <div className="facts">
                <div>
                  <span>Name</span>
                  <b>{l.founder_full_name ?? "Not in the filing"}</b>
                </div>
                <div>
                  <span>Title</span>
                  <b>{l.founder_title ?? "—"}</b>
                </div>
                <div>
                  <span>Email</span>
                  <b style={{ wordBreak: "break-all" }}>{l.direct_email ? <a href={`mailto:${l.direct_email}`}>{l.direct_email}</a> : "—"}</b>
                </div>
                <div>
                  <span>Mobile (tap for WhatsApp)</span>
                  <b>
                    {l.direct_mobile ? (
                      <a href={`https://wa.me/${waNumber(l.direct_mobile)}`} target="_blank" rel="noreferrer" style={{ color: "#128c4b" }}>
                        {prettyPhone(l.direct_mobile)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </b>
                </div>
                {l.founder_source && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <span>Name found in</span>
                    <b>{l.founder_source}</b>
                  </div>
                )}
              </div>
            ) : (
              <div className="form-grid">
                {(
                  [
                    ["founder_full_name", "Full name"],
                    ["founder_title", "Title"],
                    ["direct_email", "Email"],
                    ["direct_mobile", "Mobile"],
                    ["company_domain", "Company website (helps the search)"],
                  ] as const
                ).map(([k, label]) => (
                  <div className="field" key={k} style={k === "company_domain" ? { gridColumn: "1 / -1" } : undefined}>
                    <label htmlFor={k}>{label}</label>
                    <input id={k} className="input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  </div>
                ))}
                <div className="row" style={{ gridColumn: "1 / -1" }}>
                  <button
                    className="btn primary"
                    disabled={busy === "save"}
                    onClick={() =>
                      act("save", async () => {
                        const r = await api(`/api/leads/${id}`, { method: "PATCH", json: form });
                        setEdit(false);
                        return r;
                      }, "Saved")
                    }
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
            {!edit && canFind && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy === "enrich"} onClick={() => act("enrich", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "enrich" } }), "Looking up contact details…")}>
                  <IUserSearch />
                  Find contact
                </button>
                <span className="small">Searches BetterContact for this person's email and mobile.</span>
              </div>
            )}
            {!edit && !l.founder_full_name && (
              <p className="small" style={{ margin: "10px 0 0" }}>
                The filing doesn't name an owner. Add a name with Edit, then use Find contact.
              </p>
            )}
          </div>

          <div>
            <div className="section-t">Send</div>
            <div className="row">
              <button
                className="btn primary"
                disabled={!l.direct_email || l.auto_email_sent || Boolean(l.queued) || l.status === "unsubscribed" || busy === "initial"}
                onClick={() => act("initial", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "send", kind: "initial" } }), "New-lead email queued")}
              >
                <IMail />
                {l.auto_email_sent ? "New-lead email sent" : "Send new-lead email"}
              </button>
              <button
                className="btn"
                disabled={!l.auto_email_sent || Boolean(l.queued) || l.status === "unsubscribed" || busy === "followup"}
                onClick={() => act("followup", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "send", kind: "followup" } }), "Follow-up queued")}
              >
                <IReply />
                Send follow-up
              </button>
            </div>
            {!l.direct_email && <p className="small" style={{ margin: "8px 0 0" }}>No verified email yet.</p>}
          </div>

          <div>
            <div className="section-t">Conversation</div>
            {thread.length === 0 ? (
              <p className="small" style={{ margin: 0 }}>
                Nothing sent yet.
              </p>
            ) : (
              <div className="thread">
                {thread.map((x) =>
                  "e" in x && x.e ? (
                    <div className="msg" key={x.e.id}>
                      <div className="meta">
                        <span>
                          {KIND[x.e.kind]} · <b>{x.e.status}</b>
                          {x.e.origin ? ` · ${x.e.origin}` : ""}
                        </span>
                        <span>{fmtTime(x.e.sent_at ?? x.e.created_at)}</span>
                      </div>
                      {x.e.subject && <div style={{ fontWeight: 600, marginBottom: 4 }}>{x.e.subject}</div>}
                      {x.e.body ? <pre>{x.e.body}</pre> : <span className="small">Written from the template when it goes out.</span>}
                      {x.e.error && <div className="notice err" style={{ marginTop: 8 }}>{x.e.error}</div>}
                    </div>
                  ) : "r" in x && x.r ? (
                    <div className="msg in" key={x.r.id}>
                      <div className="meta">
                        <span>
                          Reply from <b>{x.r.from_name || x.r.from_email}</b>
                        </span>
                        <span>{fmtTime(x.r.received_at)}</span>
                      </div>
                      {x.r.subject && <div style={{ fontWeight: 600, marginBottom: 4 }}>{x.r.subject}</div>}
                      <pre>{x.r.body || "(empty message)"}</pre>
                    </div>
                  ) : null,
                )}
              </div>
            )}
            {l.direct_email && (l.auto_email_sent || d.replies.length > 0) && l.status !== "unsubscribed" && (
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="reply">Write a reply</label>
                <textarea id="reply" className="textarea" style={{ minHeight: 110 }} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`Hi ${l.founder_first_name ?? ""},`} />
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!reply.trim() || busy === "reply"}
                    onClick={() =>
                      act("reply", async () => {
                        const r = await api(`/api/leads/${id}`, { method: "POST", json: { action: "reply", message: reply } });
                        setReply("");
                        return r;
                      }, "Reply sent")
                    }
                  >
                    <IReply />
                    Send reply
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="section-t">Filing</div>
            <div className="facts">
              <div>
                <span>Debt / amount</span>
                <b>{l.debt_amount_text ?? "Not stated"}</b>
              </div>
              <div>
                <span>Stage</span>
                <b>{l.insolvency_stage ?? "—"}</b>
              </div>
              <div>
                <span>Creditors</span>
                <b>{l.creditor_summary ?? "—"}</b>
              </div>
              <div>
                <span>Case number</span>
                <b>{l.case_number ?? "—"}</b>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span>Court</span>
                <b>{l.court_name ?? "—"}</b>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span>Caption</span>
                <b>{l.case_name}</b>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              {l.cl_url && (
                <a className="btn sm" href={l.cl_url} target="_blank" rel="noreferrer">
                  <IExternal />
                  Open docket
                </a>
              )}
              {l.status !== "unsubscribed" && (
                <button
                  className="btn sm danger"
                  onClick={() => act("unsub", () => api(`/api/leads/${id}`, { method: "PATCH", json: { status: "unsubscribed" } }), "Marked do-not-contact")}
                >
                  Do not contact
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
