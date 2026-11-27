"use client";

import { useMemo, useState } from "react";
import { useFeed } from "./feed";
import { IMail, IPhone, IWhatsApp, IDetails } from "./icons";
import { api, CAT_COLOR, CAT_LABEL, contactState, daysSince, fmtDate, isNew, prettyPhone, telHref, usd, waNumber, type Lead } from "./util";

/** Update C: Send / Preview email, Call direct, WhatsApp, Open full case details. */
export function ContactButtons({ l }: { l: Lead }) {
  const { openLead } = useFeed();
  const stop = (e: React.MouseEvent) => e.stopPropagation();
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
  const { openLead, fresh, toast, refresh } = useFeed();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<"initial" | "followup" | null>(null);
  const [busy, setBusy] = useState(false);

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

  const send = async () => {
    if (!kind) return;
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

  return (
    <>
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
          <button className="btn primary" disabled={!kind || busy || eligible === 0} onClick={send}>
            {kind ? `Send to ${eligible}` : "Pick an email type"}
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
    </>
  );
}
