"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FeedProvider, useFeed } from "./feed";
import { LeadDrawer } from "./LeadDrawer";
import { IOverview, ILeads, IInbox, IOutreach, ILogs, ISettings, ISearch, IBell, IRefresh } from "./icons";
import { ago } from "./util";

const NAV = [
  { href: "/", label: "Overview", icon: IOverview },
  { href: "/leads", label: "Leads", icon: ILeads, count: "unseen" as const },
  { href: "/inbox", label: "Inbox", icon: IInbox, count: "unread_replies" as const },
  { href: "/outreach", label: "Outreach", icon: IOutreach },
  { href: "/logs", label: "Activity", icon: ILogs },
  { href: "/settings", label: "Settings", icon: ISettings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <FeedProvider>
      <Frame>{children}</Frame>
    </FeedProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { feed, updatedAt, syncing, sync, toasts, leadId, openLead, search, setSearch, error } = useFeed();
  const [, force] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5000);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => clearInterval(t);
  }, []);

  const stale = !updatedAt || Date.now() - updatedAt > 45_000 || Boolean(error);
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const count = (k?: "unseen" | "unread_replies") => (k && feed ? feed.stats[k] : 0);
  const h = feed?.health;
  const autoCount = feed ? Object.values(feed.settings.categories).filter((c) => c.auto_send).length : 0;

  return (
    <div className="shell">
      <aside className="side">
        <Link href="/" className="brand">
          <img src="/icons/icon-192.png" alt="" />
          NEXGEN
        </Link>
        <nav className="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={isOn(n.href) ? "on" : ""}>
              <n.icon />
              {n.label}
              {count(n.count) > 0 && <span className="count">{count(n.count)}</span>}
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div className="health">
            <div>
              <span className={`dot ${h?.courtlistener ? "ok" : "off"}`} /> CourtListener
            </div>
            <div>
              <span className={`dot ${h?.bettercontact ? "ok" : "off"}`} /> BetterContact
            </div>
            <div>
              <span className={`dot ${h?.mailbox ? "ok" : "off"}`} /> Mailbox
            </div>
            <div>
              <span className={`dot ${autoCount ? "ok" : "wait"}`} /> Auto-send {autoCount ? `on (${autoCount}/3)` : "off"}
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <Link href="/" className="brand-m">
            <img src="/icons/icon-192.png" alt="" />
            NEXGEN
          </Link>
          <div className={`search ${searchOpen ? "open" : ""}`}>
            <ISearch />
            <input
              placeholder="Search company, owner, email, case…"
              value={search}
              autoFocus={searchOpen}
              onBlur={() => setSearchOpen(false)}
              onChange={(e) => {
                setSearch(e.target.value);
                if (!path.startsWith("/leads")) router.push("/leads");
              }}
            />
          </div>
          <div className="spacer" />
          <span className={`live ${stale ? "stale" : ""}`} title={feed?.lastIngest ? `Last court check ${ago(feed.lastIngest)}` : ""}>
            <span className="pulse" />
            <span className="txt">{error ? "Reconnecting…" : updatedAt ? `Live · ${ago(new Date(updatedAt).toISOString())}` : "Connecting…"}</span>
          </span>
          <button className="iconbtn only-m" onClick={() => setSearchOpen(true)} aria-label="Search">
            <ISearch />
          </button>
          <Link href="/inbox" className="iconbtn" aria-label="Replies">
            <IBell />
            {(feed?.stats.unread_replies ?? 0) > 0 && <span className="badge">{feed!.stats.unread_replies}</span>}
          </Link>
          <button className="btn primary" onClick={sync} disabled={syncing}>
            <IRefresh className={syncing ? "spin" : ""} />
            <span>{syncing ? "Syncing…" : "Sync now"}</span>
          </button>
        </header>
        <main className="content">{children}</main>
      </div>

      <nav className="tabbar">
        {NAV.filter((n) => n.href !== "/logs").map((n) => (
          <Link key={n.href} href={n.href} className={isOn(n.href) ? "on" : ""}>
            <n.icon />
            {n.label}
            {count(n.count) > 0 && <span className="count">{count(n.count)}</span>}
          </Link>
        ))}
      </nav>

      {leadId && <LeadDrawer id={leadId} onClose={() => openLead(null)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
