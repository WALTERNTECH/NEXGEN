"use client";
import { Skeleton } from "@/components/Skeleton";

import { useEffect, useMemo, useState } from "react";
import { useFeed } from "@/components/feed";
import { LeadList } from "@/components/LeadList";
import { TemplateBuilder } from "@/components/TemplateBuilder";
import { IDownload } from "@/components/icons";
import { api, CAT_COLOR, CAT_LABEL, CAT_NAME, CATS, contactState, isNew, usd, type Category, type Lead } from "@/components/util";

type Filter = "all" | "new" | "not_contacted" | "contacted" | "replied" | "has_email" | "has_phone" | "no_contact" | "has_figures";
type Source = "all" | "incoming" | "backfill";

const FILTERS: { id: Filter; label: string; test: (l: Lead) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "new", label: "New", test: isNew },
  { id: "not_contacted", label: "Not contacted", test: (l) => !l.auto_email_sent && Boolean(l.direct_email || l.direct_mobile) && l.status !== "unsubscribed" && !l.replied_at },
  { id: "contacted", label: "Contacted", test: (l) => l.auto_email_sent },
  { id: "replied", label: "Replied", test: (l) => Boolean(l.replied_at) },
  { id: "has_email", label: "Has email", test: (l) => Boolean(l.direct_email) },
  { id: "has_phone", label: "Has phone", test: (l) => Boolean(l.direct_mobile) },
  { id: "has_figures", label: "Has exact debt", test: (l) => Boolean(l.debt_amount) },
  { id: "no_contact", label: "No contact yet", test: (l) => !l.direct_email && !l.direct_mobile },
];

function csv(leads: Lead[]) {
  const cols: (keyof Lead)[] = [
    "category", "company_name", "dba", "distress_type", "debt_amount", "tax_debt", "secured_debt", "unsecured_debt", "liabilities_range",
    "filing_date", "insolvency_stage", "founder_full_name", "founder_title", "direct_email", "direct_mobile", "linkedin_url", "case_number",
    "court_name", "judge", "trustee", "creditor_summary", "is_historical_backfill", "cl_url",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = leads.map((l) => [...cols.map((c) => esc(c === "category" ? CAT_LABEL[l.category] : l[c])), esc(contactState(l).label)].join(","));
  return [[...cols, "outreach"].join(","), ...rows].join("\n");
}

function Backfill() {
  const { feed, toast, refresh } = useFeed();
  const job = feed?.backfill;
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
  const [cats, setCats] = useState<Category[]>([...CATS]);
  const [busy, setBusy] = useState(false);
  const running = job?.status === "running";
  const added = job ? job.added.court + job.added.tax + job.added.debt : 0;

  const start = async () => {
    setBusy(true);
    try {
      await api("/api/backfill", { method: "POST", json: { from, to, categories: cats } });
      toast("Backfill started — historical leads are saved without using BetterContact credits");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>Historical backfill</h2>
          <div className="small">Saves older filings for browsing and filtering. They are never sent to BetterContact automatically — use Enrich now on the ones you want.</div>
        </div>
      </div>
      <div className="card-b" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {job && (
          <div className={`notice ${job.status === "error" ? "err" : job.status === "running" ? "info" : "ok"}`}>
            {job.status === "running" && `Running: ${job.from} → ${job.to}. ${job.scanned} dockets scanned, ${added} saved so far (Court ${job.added.court}, Tax ${job.added.tax}, Debt ${job.added.debt}).`}
            {job.status === "done" && `Last backfill ${job.from} → ${job.to} finished: ${added} historical leads saved.`}
            {job.status === "cancelled" && `Backfill ${job.from} → ${job.to} cancelled after ${added} leads.`}
            {job.status === "error" && `Backfill stopped: ${job.error}`}
          </div>
        )}
        {running ? (
          <button className="btn danger" style={{ alignSelf: "flex-start" }} onClick={() => api("/api/backfill", { method: "DELETE" }).then(refresh)}>
            Cancel backfill
          </button>
        ) : (
          <div className="backfill-form">
            <div className="field">
              <label htmlFor="bf-from">From</label>
              <input id="bf-from" className="input" type="date" max={today} value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="bf-to">To</label>
              <input id="bf-to" className="input" type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="field">
              <label>Categories</label>
              <div className="chips">
                {CATS.map((c) => (
                  <button key={c} className={`chip ${cats.includes(c) ? "on" : ""}`} onClick={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])}>
                    {CAT_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn primary" onClick={start} disabled={busy || !cats.length}>
              Run backfill
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LeadsPage() {
  const { feed, search, refresh } = useFeed();
  const [cat, setCat] = useState<Category | "all">("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [source, setSource] = useState<Source>("all");
  const [showBuilder, setShowBuilder] = useState(true);
  const [showBackfill, setShowBackfill] = useState(false);

  useEffect(() => {
    const p = new URL(window.location.href).searchParams;
    const c = p.get("cat");
    const f = p.get("filter");
    const src = p.get("source");
    if (c && (CATS as string[]).includes(c)) setCat(c as Category);
    if (f && FILTERS.some((x) => x.id === f)) setFilter(f as Filter);
    if (src === "backfill" || src === "all" || src === "incoming") setSource(src);
  }, []);

  const all = feed?.leads ?? [];
  const term = search.trim().toLowerCase();
  const bySearch = useMemo(
    () =>
      term
        ? all.filter((l) =>
            [l.company_name, l.dba, l.founder_full_name, l.direct_email, l.direct_mobile, l.case_number, l.case_name, l.court_name, l.judge]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(term)),
          )
        : all,
    [all, term],
  );
  const bySource = bySearch.filter((l) => (source === "all" ? true : source === "backfill" ? l.is_historical_backfill : !l.is_historical_backfill));
  const f = FILTERS.find((x) => x.id === filter)!;
  const inFilter = bySource.filter(f.test);
  const shown = cat === "all" ? inFilter : inFilter.filter((l) => l.category === cat);
  const catCount = (c: Category | "all") => (c === "all" ? inFilter.length : inFilter.filter((l) => l.category === c).length);
  const unseen = all.filter(isNew).length;
  const sum = (key: "debt_amount" | "tax_debt") => shown.reduce((s, l) => s + (Number(l[key]) || 0), 0);

  const download = () => {
    const blob = new Blob([csv(shown)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nexgen-leads-${cat}-${source}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  if (!feed) return <Skeleton />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{cat === "all" ? "Leads" : CAT_NAME[cat]}</h1>
          <p>
            {cat === "all"
              ? "Open a category to see its leads, write its email and switch on its Auto-Send."
              : `${shown.length} lead${shown.length === 1 ? "" : "s"}${sum("debt_amount") ? ` · ${usd(sum("debt_amount"))} total debt on file` : ""}${sum("tax_debt") ? ` · ${usd(sum("tax_debt"))} tax` : ""}`}
          </p>
        </div>
        <div className="row">
          {unseen > 0 && (
            <button className="btn" onClick={() => api("/api/leads/bulk", { method: "POST", json: { action: "seen" } }).then(refresh)}>
              Mark all seen ({unseen})
            </button>
          )}
          <button className={`btn ${showBackfill ? "primary" : ""}`} onClick={() => setShowBackfill(!showBackfill)}>
            Backfill{feed?.backfill?.status === "running" ? " · running" : ""}
          </button>
          <button className="btn" onClick={download} disabled={!shown.length}>
            <IDownload />
            CSV
          </button>
        </div>
      </div>

      {showBackfill && <Backfill />}

      <div className="tabs" role="tablist">
        {(["all", ...CATS] as const).map((c) => (
          <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
            {c !== "all" && (
              <span className="cat">
                <i style={{ background: CAT_COLOR[c] }} />
              </span>
            )}
            {c === "all" ? "All" : CAT_NAME[c]}
            <span className="n">{catCount(c)}</span>
            {c !== "all" && feed?.settings.categories[c]?.auto_send && (
              <span className="pill green" style={{ height: 18, fontSize: 11 }}>
                Auto
              </span>
            )}
          </button>
        ))}
      </div>

      {cat !== "all" && (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">
              {feed?.templatesSaved?.[cat] ? "This category's email is saved." : "Write and save this category's email, then switch on its Auto-Send."}
            </span>
            <button className="btn sm" onClick={() => setShowBuilder(!showBuilder)}>
              {showBuilder ? "Hide email builder" : "Show email builder"}
            </button>
          </div>
          {showBuilder && <TemplateBuilder key={cat} category={cat} />}
        </>
      )}

      <div className="toolbar">
        <div className="tabs">
          {(["all", "incoming", "backfill"] as const).map((s) => (
            <button key={s} className={source === s ? "on" : ""} onClick={() => setSource(s)}>
              {s === "incoming" ? "New only" : s === "backfill" ? "Backfill only" : "All leads"}
              <span className="n">{s === "all" ? bySearch.length : bySearch.filter((l) => (s === "backfill" ? l.is_historical_backfill : !l.is_historical_backfill)).length}</span>
            </button>
          ))}
        </div>
        <div className="chips">
          {FILTERS.map((x) => (
            <button key={x.id} className={`chip ${filter === x.id ? "on" : ""}`} onClick={() => setFilter(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: "visible" }}>
        <LeadList
          leads={shown}
          empty={
            <>
              <b>Nothing matches</b>
              {term ? `No lead matches “${search}”.` : source === "backfill" ? "Run a backfill to load older filings." : "Try another tab or filter."}
            </>
          }
        />
      </div>
    </>
  );
}
