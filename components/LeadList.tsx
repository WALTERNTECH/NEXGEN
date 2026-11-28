"use client";

import { useMemo, useState } from "react";
import { useFeed, whenText } from "./feed";
import { IMail, IPhone, IWhatsApp, IDetails, ITrash } from "./icons";
import { api, CAT_COLOR, CAT_LABEL, contactState, daysSince, fmtDate, isNew, prettyPhone, telHref, usd, waNumber, type Lead } from "./util";

/** Update C: Send / Preview email, Call direct, WhatsApp, Open full case details. */
export function ContactButtons({ l }: { l: Lead }) {
  const { openLead, toast, refresh } = useFeed();
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const remove = async () => {
    if (!confirm(`Delete ${l.company_name}? It disappears from NEXGEN for good${l.auto_email_sent ? " and its address stays blocked from further emails" : ""}.`)) return;
    try {
      await api(`/api/leads/${l.id}`, { method: "DELETE" });
      toast(`${l.company_name} deleted`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="acts" onClick={stop}>
      <button
        className={`act ${l.direct_email ? "" : "off"}`}
        onClick={() => openLead(l.id, "email")}
        title={l.auto_email_sent ? "Preview / send follow-up" : "Preview / send email"}
        aria-label="Preview and send email"
      >
        <IMail />
      </button>
      <a className={`act ${l.direct_mobile ? "" : "off"}`} href={l.direct_mobile ? telHref(l.direct_mobile) : undefined} title="Call" aria-label="Call">
        <IPhone />
      </a>
      <a
        className={`act wa ${l.direct_mobile ? "" : "off"}`}
        href={l.direct_mobile ? `https://wa.me/${waNumber(l.direct_mobile)}` : undefined}
        target="_blank"
        rel="noreferrer"
        title="WhatsApp"
        aria-label="WhatsApp"
      >
        <IWhatsApp />
      </a>
      <button className="act" onClick={() => openLead(l.id, "details")} title="Full case details" aria-label="Full case details">
        <IDetails />
      </button>
      <button className="act del" onClick={remove} title="Delete lead" aria-label={`Delete ${l.company_name}`}>
        <ITrash />
      </button>
    </div>
  );
}

function Money({ l }: { l: Lead }) {
  const total = usd(l.debt_amount);
  const tax = usd(l.tax_debt);
  return (
    <>
      {total ? <b className="num">{total}</b> : l.liabilities_range ? <span className="num">{l.liabilities_range}</span> : <span className="muted">Not public yet</span>}
      {tax && <div className="small num">Tax {tax}</div>}
      {!tax && l.creditor_summary && <div className="small" style={{ maxWidth: 170, whiteSpace: "normal" }}>{l.creditor_summary}</div>}
    </>
  );
}

function Phone({ l }: { l: Lead }) {
  if (!l.direct_mobile) return null;
  return (
    <div className="contact-line">
      <a
        href={`https://wa.me/${waNumber(l.direct_mobile)}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Open in WhatsApp"
        style={{ color: "#128c4b", fontWeight: 500 }}
        className="num"
      >
        {prettyPhone(l.direct_mobile)}
      </a>
    </div>
  );
}

function Email({ l }: { l: Lead }) {
  if (!l.direct_email) return null;
  return (
    <div className="contact-line" style={{ overflowWrap: "anywhere" }}>
      <a href={`mailto:${l.direct_email}`} onClick={(e) => e.stopPropagation()}>
        {l.direct_email}
      </a>
    </div>
  );
}

export function LeadList({ leads, selectable = true, empty }: { leads: Lead[]; selectable?: boolean; empty?: React.ReactNode }) {
  const { openLead, fresh, toast, refresh, feed } = useFeed();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<"initial" | "followup" | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ emails: BulkEmail[]; address: string; at: number } | null>(null);

  const visibleIds = useMemo(() => new Set(leads.map((l) => l.id)), [leads]);
  const selected = [...sel].filter((id) => visibleIds.has(id));
  const allOn = leads.length > 0 && selected.length === leads.length;
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectedLeads = leads.filter((l) => sel.has(l.id));
  const eligible = kind
    ? selectedLeads.filter((l) => l.direct_email && l.status !== "unsubscribed" && !l.queued && (kind === "initial" ? !l.auto_email_sent : l.auto_email_sent)).length
    : 0;

  // Before anything goes out: build every selected lead's own email so you can step through them.
  const openReview = async () => {
    if (!kind) return;
    setBusy(true);
    try {
      const r = await api<{ emails: BulkEmail[]; physical_address: string }>("/api/leads/bulk", { method: "POST", json: { action: "preview", kind, ids: selected } });
      if (!r.emails.length) toast("None of the selected leads can get this email", true);
      else setReview({ emails: r.emails, address: r.physical_address, at: 0 });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!kind) return;
    setReview(null);
    setBusy(true);
    try {
      const r = await api<{ queued: number; skipped: Record<string, number> }>("/api/leads/bulk", { method: "POST", json: { action: "send", kind, ids: selected } });
      const skipped = Object.entries(r.skipped).map(([k, v]) => `${v} ${k.toLowerCase()}`);
      toast(`${r.queued} ${kind === "initial" ? "new-lead email" : "follow-up"}${r.queued === 1 ? "" : "s"} queued${skipped.length ? ` · skipped ${skipped.join(", ")}` : ""}`);
      setSel(new Set());
      setKind(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  // Update A: backfill rows (and misses) reach BetterContact only when you ask.
  const enrichable = selectedLeads.filter((l) => (l.status === "not_enriched_backfill" || l.status === "enrichment_failed") && l.founder_full_name?.includes(" ")).length;
  const enrichNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: string }>("/api/leads/bulk", { method: "POST", json: { action: "enrich", ids: selected } });
      toast(/^sent/.test(r.result) ? `Enrich now: ${r.result.replace("sent", "sent")} to BetterContact` : r.result, !/^sent/.test(r.result));
      setSel(new Set());
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const markSeen = async () => {
    await api("/api/leads/bulk", { method: "POST", json: { action: "seen", ids: selected } }).catch(() => {});
    setSel(new Set());
    refresh();
  };

  if (!leads.length) return <div className="empty">{empty ?? <b>No leads here yet</b>}</div>;
  const plans = (feed?.sendPlans ?? []).filter((p) => p.queued > 0);
  const waiting = (feed?.waiting ?? []).filter((w) => w.queued > 0);

  return (
    <>
      {waiting.map((w) => (
        <div className="notice" style={{ marginBottom: 10 }} key={w.category}>
          <b>
            {w.queued} {CAT_LABEL[w.category as keyof typeof CAT_LABEL] ?? w.category} email{w.queued === 1 ? "" : "s"} waiting
          </b>{" "}
          — {w.assigned ? <>assigned to {w.assigned}, which isn&apos;t connected.</> : <>this category has no mailbox yet.</>} Connect one in Settings → Mailboxes and choose{" "}
          {CAT_LABEL[w.category as keyof typeof CAT_LABEL] ?? w.category}.
        </div>
      ))}
      {plans.length > 0 && (
        <div className="notice" style={{ marginBottom: 10 }}>
          {plans.map((plan) => (
            <div key={plan.email}>
              <b>
                {plan.queued} queued from {plan.email}
              </b>{" "}
              ({plan.categories.map((c) => CAT_LABEL[c as keyof typeof CAT_LABEL] ?? c).join(", ")}) — next one goes out <b>{whenText(plan.nextAt)}</b>. {plan.why}. Warm-up day{" "}
              {plan.day}: up to {plan.perDay} a day, about one every {plan.spreadMin >= 60 ? `${+(plan.spreadMin / 60).toFixed(1)} h` : `${plan.spreadMin} min`} (
              {plan.sentToday} sent in the last 24 h).
            </div>
          ))}
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" className="check" aria-label="Select all" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(leads.map((l) => l.id)))} />
                </th>
              )}
              <th>Company</th>
              <th>Total debt / tax</th>
              <th>Filed</th>
              <th>Owner</th>
              <th>Contact</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const days = daysSince(l.filing_date);
              return (
                <tr key={l.id} className={`${fresh.has(l.id) ? "fresh" : ""} ${isNew(l) ? "unseen" : ""}`} onClick={() => openLead(l.id)}>
                  {selectable && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="check" aria-label={`Select ${l.company_name}`} checked={sel.has(l.id)} onChange={() => toggle(l.id)} />
                    </td>
                  )}
                  <td style={{ maxWidth: 300 }}>
                    <div className="co">
                      {l.company_name} {isNew(l) && <span className="pill new">NEW</span>}
                      {l.is_historical_backfill && <span className="pill gray">BACKFILL</span>}
                    </div>
                    <div className="small">
                      <span className="cat" style={{ marginRight: 8 }}>
                        <i style={{ background: CAT_COLOR[l.category] }} />
                        {CAT_LABEL[l.category]}
                      </span>
                      {l.distress_type}
                    </div>
                  </td>
                  <td className="nowrap">
                    <Money l={l} />
                  </td>
                  <td className="nowrap">
                    {fmtDate(l.filing_date)}
                    <div className="small">{days !== null ? `${days} day${days === 1 ? "" : "s"}` : ""}</div>
                  </td>
                  <td style={{ maxWidth: 170 }}>
                    {l.founder_full_name ?? <span className="muted">Unknown</span>}
                    {l.founder_title && <div className="small">{l.founder_title}</div>}
                  </td>
                  <td style={{ maxWidth: 230 }}>
                    <Email l={l} />
                    <Phone l={l} />
                    {!l.direct_email && !l.direct_mobile && <span className="muted">—</span>}
                  </td>
                  <td>
                    <span className={`pill ${contactState(l).tone}`}>
                      {contactState(l).label}
                    </span>
                  </td>
                  <td>
                    <ContactButtons l={l} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="lead-cards">
        {leads.map((l) => {
          const days = daysSince(l.filing_date);
          const st = contactState(l);
          return (
            <div key={l.id} className={`lead-card ${fresh.has(l.id) ? "fresh" : ""} ${isNew(l) ? "unseen" : ""}`} onClick={() => openLead(l.id)}>
              <div className="top-line">
                {selectable && (
                  <input
                    type="checkbox"
                    className="check"
                    style={{ marginTop: 2 }}
                    aria-label={`Select ${l.company_name}`}
                    checked={sel.has(l.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(l.id)}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="co">{l.company_name}</div>
                  <div className="small">
                    <span className="cat" style={{ marginRight: 6 }}>
                      <i style={{ background: CAT_COLOR[l.category] }} />
                      {CAT_LABEL[l.category]}
                    </span>
                    {usd(l.debt_amount) ? `${usd(l.debt_amount)} · ` : ""}
                    {usd(l.tax_debt) ? `Tax ${usd(l.tax_debt)} · ` : ""}
                    {fmtDate(l.filing_date)}
                    {days !== null ? ` · ${days}d` : ""}
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {isNew(l) && <span className="pill new">NEW</span>}
                {l.is_historical_backfill && <span className="pill gray">BACKFILL</span>}
                <span className={`pill ${st.tone}`}>{st.label}</span>
              </div>
              {l.founder_full_name && (
                <div style={{ fontSize: 13 }}>
                  {l.founder_full_name}
                  {l.founder_title ? <span className="muted"> · {l.founder_title}</span> : null}
                </div>
              )}
              <Email l={l} />
              <Phone l={l} />
              <ContactButtons l={l} />
            </div>
          );
        })}
      </div>

      {selectable && selected.length > 0 && (
        <div className="bulk">
          <b style={{ marginRight: 4 }}>{selected.length} selected</b>
          <div className="seg" role="radiogroup" aria-label="Which email">
            <button className={kind === "initial" ? "on" : ""} onClick={() => setKind("initial")} role="radio" aria-checked={kind === "initial"}>
              New-lead email
            </button>
            <button className={kind === "followup" ? "on" : ""} onClick={() => setKind("followup")} role="radio" aria-checked={kind === "followup"}>
              Follow-up email
            </button>
          </div>
          <button className="btn primary" disabled={!kind || busy || eligible === 0} onClick={openReview}>
            {kind ? `Review & send to ${eligible}` : "Pick an email type"}
          </button>
          {kind && eligible < selected.length && (
            <span style={{ fontSize: 12, color: "#cbd2e1" }}>
              {selected.length - eligible} skipped ({kind === "initial" ? "already contacted or no email" : "not contacted yet or no email"})
            </span>
          )}
          <span style={{ flex: 1 }} />
          {enrichable > 0 && (
            <button className="btn ghost" onClick={enrichNow} disabled={busy}>
              Enrich now ({enrichable})
            </button>
          )}
          <button className="btn ghost" onClick={markSeen}>
            Mark seen
          </button>
          <button className="btn ghost" onClick={() => setSel(new Set())}>
            Clear
          </button>
        </div>
      )}
      {review && kind && (() => {
        const e = review.emails[review.at];
        const n = review.emails.length;
        const go = (d: number) => setReview({ ...review, at: (review.at + d + n) % n });
        return (
          <>
            <div className="scrim" onClick={() => setReview(null)} />
            <div className="review" role="dialog" aria-label="Review emails before sending">
              <div className="review-h">
                <div>
                  <b>
                    {n} {kind === "initial" ? "new-lead" : "follow-up"} email{n === 1 ? "" : "s"} — each written for its own lead
                  </b>
                  <div className="small">Step through them; nothing is sent until you press Send.</div>
                </div>
                <button className="btn ghost sm" onClick={() => setReview(null)} aria-label="Close">
                  ✕
                </button>
              </div>
              <div className="row" style={{ justifyContent: "space-between", margin: "10px 0" }}>
                <button className="btn ghost sm" onClick={() => go(-1)} disabled={n < 2}>
                  ‹ Previous
                </button>
                <span className="small">
                  {review.at + 1} of {n} · {e.company}
                </span>
                <button className="btn ghost sm" onClick={() => go(1)} disabled={n < 2}>
                  Next ›
                </button>
              </div>
              <div className="preview" style={{ maxHeight: "50vh", overflow: "auto" }}>
                <div className="small">To: {e.to}</div>
                <div className="subj">{e.subject}</div>
                <pre>{e.body}</pre>
                <div className="foot">
                  {review.address && (
                    <>
                      {review.address}
                      <br />
                    </>
                  )}
                  Don&apos;t want these emails? <u>Unsubscribe</u>
                </div>
              </div>
              {e.missing.length > 0 && (
                <p className="small" style={{ color: "var(--warn)" }}>
                  No {e.missing.join(", ").replace(/_/g, " ")} on record for this lead — a neutral phrase is used.
                </p>
              )}
              <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn ghost" onClick={() => setReview(null)}>
                  Cancel
                </button>
                <button className="btn primary" onClick={send} disabled={busy}>
                  Send all {n}
                </button>
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
}

interface BulkEmail {
  id: string;
  company: string;
  category: string;
  to: string;
  subject: string;
  body: string;
  missing: string[];
}
