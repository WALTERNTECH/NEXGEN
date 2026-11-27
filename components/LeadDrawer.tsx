"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFeed } from "./feed";
import { IX, IMail, IPhone, IWhatsApp, ILinkedIn, IExternal, IUserSearch, IReply } from "./icons";
import { api, CAT_COLOR, CAT_LABEL, CAT_NAME, contactState, daysSince, fmtDate, fmtTime, prettyPhone, telHref, usd, waNumber, type Lead } from "./util";

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
  preview: Record<"initial" | "followup", { subject: string; body: string; saved: boolean }>;
  physical_address: string;
}

const KIND: Record<string, string> = { initial: "New-lead email", followup: "Follow-up", reply: "Your reply" };

export function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast, refresh, leadFocus } = useFeed();
  const [d, setD] = useState<Detail | null>(null);
  const [pkind, setPkind] = useState<"initial" | "followup">("initial");
  const editing = useRef(false);
  const scrolled = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState({ founder_full_name: "", founder_title: "", direct_email: "", direct_mobile: "", company_domain: "" });
  const [reply, setReply] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/leads/${id}`);
      setD(r);
      if (!scrolled.current) setPkind(r.lead.auto_email_sent ? "followup" : "initial");
      if (!editing.current) setForm({
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

  useEffect(() => {
    editing.current = edit;
  }, [edit]);

  useEffect(() => {
    if (!d || scrolled.current) return;
    scrolled.current = true;
    if (leadFocus) setTimeout(() => document.getElementById(leadFocus === "email" ? "sec-email" : "sec-details")?.scrollIntoView({ block: "start" }), 250);
  }, [d, leadFocus]);

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
  const canFind = ["enrichment_failed", "discovered", "not_enriched_backfill"].includes(l.status) && Boolean(l.founder_full_name?.includes(" "));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={l.company_name}>
        <div className="drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="cat">
                <i style={{ background: CAT_COLOR[l.category] }} />
                {CAT_NAME[l.category]}
              </span>
              {l.is_historical_backfill && <span className="pill gray">BACKFILL</span>}
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
            <a className={`bigact ${l.direct_email ? "" : "off"}`} onClick={() => document.getElementById("sec-email")?.scrollIntoView({ behavior: "smooth" })} style={{ cursor: "pointer" }}>
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
                  Enrich now
                </button>
                <span className="small">{l.is_historical_backfill ? "Backfill leads are never enriched automatically — this uses BetterContact credits for this one lead." : "Searches BetterContact for this person's email and mobile."}</span>
              </div>
            )}
            {!edit && !l.founder_full_name && !l.direct_email && (
              <div style={{ marginTop: 12 }}>
                <div className="row">
                  <button
                    className="btn"
                    disabled={busy === "owner" || l.status === "enriching"}
                    onClick={() => act("owner", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "owner" } }), "Owner search done")}
                  >
                    <IUserSearch />
                    {busy === "owner" ? "Searching registries & website…" : l.status === "enriching" ? "Searching…" : "Find owner"}
                  </button>
                  <span className="small">Checks state business registries and the company website, then BetterContact.</span>
                </div>
                <p className="small" style={{ margin: "8px 0 0" }}>
                  {l.owner_lookup_note ? `Last search: ${l.owner_lookup_note}.` : "The filing doesn't name an owner yet."} You can also add a name with Edit, then use Enrich now.
                </p>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14 }} id="sec-email">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="section-t" style={{ margin: 0 }}>
                {CAT_LABEL[l.category]} email — preview &amp; send
              </div>
              <div className="tabs">
                <button className={pkind === "initial" ? "on" : ""} onClick={() => setPkind("initial")}>
                  New-lead
                </button>
                <button className={pkind === "followup" ? "on" : ""} onClick={() => setPkind("followup")}>
                  Follow-up
                </button>
              </div>
            </div>
            <div className="preview">
              <div className="small">To: {l.direct_email ?? "no verified email yet"}</div>
              <div className="subj">{d.preview[pkind].subject}</div>
              <pre>{d.preview[pkind].body}</pre>
              <div className="foot">
                {d.physical_address && (
                  <>
                    {d.physical_address}
                    <br />
                  </>
                )}
                Don&apos;t want these emails? <u>Unsubscribe</u>
              </div>
            </div>
            {!d.preview[pkind].saved && (
              <p className="small" style={{ margin: "8px 0 0" }}>
                This is the starting draft for {CAT_LABEL[l.category]}. Edit and save it in the {CAT_LABEL[l.category]} tab on Leads, or on Outreach.
              </p>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              {pkind === "initial" ? (
                <button
                  className="btn primary"
                  disabled={!l.direct_email || l.auto_email_sent || Boolean(l.queued) || l.status === "unsubscribed" || busy === "initial"}
                  onClick={() => act("initial", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "send", kind: "initial" } }), "New-lead email queued")}
                >
                  <IMail />
                  {l.auto_email_sent ? "Already sent — never twice" : l.queued ? "Queued" : "Send this email"}
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={!l.auto_email_sent || Boolean(l.queued) || l.status === "unsubscribed" || busy === "followup"}
                  onClick={() => act("followup", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "send", kind: "followup" } }), "Follow-up queued")}
                >
                  <IReply />
                  {!l.auto_email_sent ? "Send the new-lead email first" : l.queued ? "Queued" : "Send follow-up"}
                </button>
              )}
              {!l.direct_email && <span className="small">Enrich the lead or add an email to send.</span>}
            </div>
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

          <div className="card" style={{ padding: 14 }} id="sec-details">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="section-t" style={{ margin: 0 }}>
                Full case details
              </div>
              <button
                className="btn sm"
                disabled={busy === "details"}
                onClick={() => act("details", () => api(`/api/leads/${id}`, { method: "POST", json: { action: "details" } }), "Case re-read from the court record")}
              >
                {busy === "details" ? "Reading…" : "Refresh from court record"}
              </button>
            </div>

            <div className="figs">
              <div className="fig">
                <span>Exact total debt</span>
                <b>{usd(l.debt_amount) ?? (l.liabilities_range ? `${l.liabilities_range} (range)` : "Not public yet")}</b>
              </div>
              <div className="fig">
                <span>Exact tax debt (IRS / state)</span>
                <b>{usd(l.tax_debt) ?? "—"}</b>
              </div>
              <div className="fig">
                <span>Secured debt</span>
                <b>{usd(l.secured_debt) ?? "—"}</b>
              </div>
              <div className="fig">
                <span>Unsecured debt</span>
                <b>{usd(l.unsecured_debt) ?? "—"}</b>
                {usd(l.priority_debt) && <small className="small">incl. priority {usd(l.priority_debt)}</small>}
              </div>
            </div>
            <p className="small" style={{ margin: "8px 0 12px" }}>
              {l.figures_source
                ? `Source: ${l.figures_source}.`
                : l.details_checked_at
                  ? `Checked ${fmtTime(l.details_checked_at)} — the schedules or complaint aren't in the public record yet${l.category === "court" ? " (debtors usually file schedules within 14 days; re-checked daily)" : ""}.`
                  : "Reading the court record…"}
            </p>

            <div className="facts">
              <div style={{ gridColumn: "1 / -1" }}>
                <span>Company legal name{l.dba ? " & DBA" : ""}</span>
                <b>
                  {l.company_name}
                  {l.dba ? ` (d/b/a ${l.dba})` : ""}
                </b>
              </div>
              <div>
                <span>Owner / officer</span>
                <b>
                  {l.founder_full_name ?? "Not named"}
                  {l.founder_title ? `, ${l.founder_title}` : ""}
                </b>
              </div>
              <div>
                <span>Case number</span>
                <b>{l.case_number ?? "—"}</b>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span>Court</span>
                <b>{l.court_name ?? "—"}</b>
              </div>
              <div>
                <span>Judge</span>
                <b>{l.judge ?? "—"}</b>
              </div>
              <div>
                <span>Trustee</span>
                <b>{l.trustee ?? "—"}</b>
              </div>
              <div>
                <span>Filing date</span>
                <b>{fmtDate(l.filing_date, true)}</b>
              </div>
              <div>
                <span>Days in distress</span>
                <b>{days ?? "—"}</b>
              </div>
              <div>
                <span>Insolvency stage</span>
                <b>{l.insolvency_stage ?? "—"}</b>
              </div>
              <div>
                <span>Creditors</span>
                <b>{l.creditor_summary ?? "—"}</b>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span>Caption</span>
                <b>{l.case_name}</b>
              </div>
              {l.case_summary && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <span>Case summary</span>
                  <b style={{ fontWeight: 400 }}>{l.case_summary}</b>
                </div>
              )}
              <div>
                <span>Verified email</span>
                <b style={{ overflowWrap: "anywhere" }}>{l.direct_email ?? "—"}</b>
              </div>
              <div>
                <span>Direct mobile</span>
                <b>{l.direct_mobile ? prettyPhone(l.direct_mobile) : "—"}</b>
              </div>
            </div>

            {l.case_notes && l.case_notes.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary className="small" style={{ cursor: "pointer" }}>
                  Case notes — {l.case_notes.length} docket entr{l.case_notes.length === 1 ? "y" : "ies"}
                </summary>
                <div className="notes">
                  {l.case_notes.map((n, i) => (
                    <div key={i} className="note">
                      <span className="small">
                        {n.date ? fmtDate(n.date) : ""}
                        {n.no ? ` · #${n.no}` : ""}
                      </span>
                      <span>{n.text}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

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
