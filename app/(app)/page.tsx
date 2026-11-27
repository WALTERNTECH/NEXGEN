"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFeed } from "@/components/feed";
import { AreaChart, StackedBars, Donut } from "@/components/charts";
import { LeadList } from "@/components/LeadList";
import { ago, CAT_LABEL, CATS } from "@/components/util";

function Kpi({ label, value, delta, foot }: { label: string; value: number | string; delta?: string | null; foot?: string }) {
  return (
    <div className="card kpi">
      <span className="label">{label}</span>
      <span className="value num">
        {value}
        {delta !== undefined && <span className={`delta ${delta ? "" : "flat"}`}>{delta ?? "0 this week"}</span>}
      </span>
      {foot && <span className="foot">{foot}</span>}
    </div>
  );
}

export default function Overview() {
  const { feed, error } = useFeed();
  const router = useRouter();
  if (!feed) return <div className="muted">{error ?? "Loading…"}</div>;
  const s = feed.stats;
  const h = feed.health;
  const setupMissing = [!h.courtlistener && "CourtListener key", !h.bettercontact && "BetterContact key", !h.mailbox && "mailbox"].filter(Boolean);
  const perDay = feed.perDay.map((d) => ({ day: d.day, v: d.court + d.tax + d.debt }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            Court checks every {feed.settings.ingest_every_min} min · last {ago(feed.lastIngest)}
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {CATS.map((c) => (
            <Link
              key={c}
              href={`/leads?cat=${c}`}
              className={`pill ${feed.settings.categories[c]?.auto_send ? "green" : "gray"}`}
              style={{ height: 28, padding: "0 10px" }}
            >
              {CAT_LABEL[c]} auto-send {feed.settings.categories[c]?.auto_send ? "ON" : "off"}
            </Link>
          ))}
        </div>
      </div>

      {setupMissing.length > 0 && (
        <div className="notice">
          Still to connect: {setupMissing.join(", ")}. <Link href="/settings" style={{ textDecoration: "underline" }}>Open Settings</Link>
        </div>
      )}

      <div className="kpis">
        <Kpi label="Distressed companies" value={s.total.toLocaleString()} delta={s.total_7d ? `+${s.total_7d} this week` : null} foot={`${s.unseen} not opened yet${s.backfill ? ` · ${s.backfill} backfill` : ""}`} />
        <Kpi label="Direct contacts found" value={s.contacts.toLocaleString()} delta={s.contacts_7d ? `+${s.contacts_7d} this week` : null} foot={s.total ? `${Math.round((s.contacts / s.total) * 100)}% of leads` : undefined} />
        <Kpi label="Emails sent" value={s.sent.toLocaleString()} foot={`${s.sent_24h} in 24 h · ${s.queued} queued${s.failed ? ` · ${s.failed} failed` : ""}`} />
        <Kpi label="Replies" value={s.replied.toLocaleString()} foot={s.unread_replies ? `${s.unread_replies} unread` : "All read"} />
      </div>

      <div className="grid-3">
        <div className="card">
          <div className="card-h">
            <h2>Leads found</h2>
            <span className="small">Last 30 days</span>
          </div>
          <div className="card-b">
            <AreaChart data={perDay} label="Leads" />
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>New leads per day</h2>
            <span className="small">Last 14 days</span>
          </div>
          <div className="card-b">
            <StackedBars data={feed.perDay.slice(-14)} />
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>By category</h2>
          </div>
          <div className="card-b">
            <Donut counts={{ court: s.court, tax: s.tax, debt: s.debt }} onPick={(c) => router.push(`/leads?cat=${c}`)} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Latest leads</h2>
          <Link href="/leads" className="btn sm">
            View all
          </Link>
        </div>
        <LeadList
          leads={feed.leads.slice(0, 8)}
          selectable={false}
          empty={
            <>
              <b>No leads yet</b>
              {h.courtlistener ? "Press Sync now to check the courts." : "Connect CourtListener in Settings to start."}
            </>
          }
        />
      </div>
    </>
  );
}
