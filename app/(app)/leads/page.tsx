"use client";

import { useEffect, useMemo, useState } from "react";
import { useFeed } from "@/components/feed";
import { LeadList } from "@/components/LeadList";
import { IDownload } from "@/components/icons";
import { api, CAT_LABEL, CATS, contactState, isNew, type Category, type Lead } from "@/components/util";

type Filter = "all" | "new" | "not_contacted" | "contacted" | "replied" | "has_email" | "has_phone" | "no_contact";

const FILTERS: { id: Filter; label: string; test: (l: Lead) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "new", label: "New", test: isNew },
  { id: "not_contacted", label: "Not contacted", test: (l) => !l.auto_email_sent && Boolean(l.direct_email || l.direct_mobile) && l.status !== "unsubscribed" && !l.replied_at },
  { id: "contacted", label: "Contacted", test: (l) => l.auto_email_sent },
  { id: "replied", label: "Replied", test: (l) => Boolean(l.replied_at) },
  { id: "has_email", label: "Has email", test: (l) => Boolean(l.direct_email) },
  { id: "has_phone", label: "Has phone", test: (l) => Boolean(l.direct_mobile) },
  { id: "no_contact", label: "No contact yet", test: (l) => !l.direct_email && !l.direct_mobile },
];

function csv(leads: Lead[]) {
  const cols: (keyof Lead)[] = [
    "category", "company_name", "distress_type", "debt_amount_text", "filing_date", "insolvency_stage", "founder_full_name", "founder_title",
    "direct_email", "direct_mobile", "linkedin_url", "case_number", "court_name", "cl_url",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = leads.map((l) => [...cols.map((c) => esc(c === "category" ? CAT_LABEL[l.category] : l[c])), esc(contactState(l).label)].join(","));
  return [[...cols, "outreach"].join(","), ...rows].join("\n");
}

export default function LeadsPage() {
  const { feed, search, refresh } = useFeed();
  const [cat, setCat] = useState<Category | "all">("all");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    const p = new URL(window.location.href).searchParams;
    const c = p.get("cat");
    const f = p.get("filter");
    if (c && (CATS as string[]).includes(c)) setCat(c as Category);
    if (f && FILTERS.some((x) => x.id === f)) setFilter(f as Filter);
  }, []);

  const all = feed?.leads ?? [];
  const term = search.trim().toLowerCase();
  const bySearch = useMemo(
    () =>
      term
        ? all.filter((l) =>
            [l.company_name, l.founder_full_name, l.direct_email, l.direct_mobile, l.case_number, l.case_name, l.court_name]
              .filter(Boolean)
              .some((v) => String(v).toLowerCase().includes(term)),
          )
        : all,
    [all, term],
  );
  const f = FILTERS.find((x) => x.id === filter)!;
  const inFilter = bySearch.filter(f.test);
  const shown = cat === "all" ? inFilter : inFilter.filter((l) => l.category === cat);
  const catCount = (c: Category | "all") => (c === "all" ? inFilter.length : inFilter.filter((l) => l.category === c).length);
  const unseen = all.filter(isNew).length;

  const download = () => {
    const blob = new Blob([csv(shown)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nexgen-leads-${cat}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p>Grouped by Court, Tax and Debt. New arrivals show a blue NEW tag until you open them.</p>
        </div>
        <div className="row">
          {unseen > 0 && (
            <button className="btn" onClick={() => api("/api/leads/bulk", { method: "POST", json: { action: "seen" } }).then(refresh)}>
              Mark all seen ({unseen})
            </button>
          )}
          <button className="btn" onClick={download} disabled={!shown.length}>
            <IDownload />
            CSV
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {(["all", ...CATS] as const).map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>
              {c === "all" ? "All" : CAT_LABEL[c]}
              <span className="n">{catCount(c)}</span>
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
              {term ? `No lead matches “${search}”.` : "Try another tab or filter."}
            </>
          }
        />
      </div>
    </>
  );
}
