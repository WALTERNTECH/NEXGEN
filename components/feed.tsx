"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type Lead, type Category } from "./util";

export interface SendPlan {
  queued: number;
  nextAt: string | null;
  why: string;
  day: number;
  perDay: number;
  spreadMin: number;
  sentToday: number;
}

/** "Mon 3:00 PM" in the viewer's own time, or "in 12 min" when it's soon. */
export function whenText(iso: string | null) {
  if (!iso) return "not scheduled";
  const ms = Date.parse(iso) - Date.now();
  if (ms < 90_000) return "within a minute";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export interface Feed {
  sendPlan?: SendPlan | null;
  now: string;
  leads: Lead[];
  stats: {
    total: number;
    total_7d: number;
    contacts: number;
    contacts_7d: number;
    unseen: number;
    replied: number;
    court: number;
    tax: number;
    debt: number;
    queued: number;
    sent: number;
    sent_24h: number;
    failed: number;
    unread_replies: number;
    backfill: number;
  };
  templatesSaved: Record<Category, boolean>;
  courtlistener?: { pausedUntil: string | null; searchesLeft: number | null };
  pipeline?: { researching: number; no_contact: number; below_minimum: number; backfill_waiting: number; scanned: number };
  credits?: { betterContact: { left: number; at: string } | null; betterContactPaused: { at: string; reason: string } | null; hunterPausedUntil: string | null };
  backfill: {
    from: string;
    to: string;
    categories: Category[];
    done: Category[];
    added: Record<Category, number>;
    scanned: number;
    status: "running" | "done" | "cancelled" | "error";
    error?: string | null;
    started_at: string;
    finished_at?: string | null;
  } | null;
  perDay: { day: string; court: number; tax: number; debt: number }[];
  sentPerDay: { day: string; sent: number }[];
  settings: {
    auto_send: boolean;
    send_gap_min: number;
    daily_limit: number;
    ingest_every_min: number;
    categories: Record<Category, { on: boolean; query: string; auto_send: boolean }>;
  };
  lastTick: string | null;
  lastIngest: string | null;
  health: {
    courtlistener: string | null;
    bettercontact: string | null;
    openai: string | null;
    mailbox: string | null;
    mailboxKind: string | null;
    pushDevices: number;
  };
}

interface Toast {
  id: number;
  text: string;
  err?: boolean;
}

interface Ctx {
  feed: Feed | null;
  error: string | null;
  updatedAt: number;
  refresh: () => Promise<void>;
  syncing: boolean;
  sync: () => Promise<void>;
  toast: (text: string, err?: boolean) => void;
  toasts: Toast[];
  openLead: (id: string | null, focus?: "email" | "details" | null) => void;
  leadId: string | null;
  leadFocus: "email" | "details" | null;
  fresh: Set<string>;
  search: string;
  setSearch: (s: string) => void;
}

const FeedCtx = createContext<Ctx | null>(null);

export function useFeed() {
  const c = useContext(FeedCtx);
  if (!c) throw new Error("useFeed outside provider");
  return c;
}

const POLL_MS = 15_000;

export function FeedProvider({ children }: { children: React.ReactNode }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [leadFocus, setLeadFocus] = useState<"email" | "details" | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const known = useRef<Set<string> | null>(null);
  // A page left open keeps running the code it loaded with; when a newer version is deployed, offer a reload.
  const [stale, setStale] = useState(false);
  const inflight = useRef(false);

  const toast = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 6000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const f = await api<Feed & { build?: string | null }>("/api/feed");
      if (f.build && process.env.NEXT_PUBLIC_BUILD_STAMP && f.build !== process.env.NEXT_PUBLIC_BUILD_STAMP) setStale(true);
      const ids = new Set(f.leads.map((l) => l.id));
      if (known.current) {
        const added = f.leads.filter((l) => !known.current!.has(l.id));
        if (added.length) {
          setFresh(new Set(added.map((l) => l.id)));
          toast(`${added.length} new lead${added.length === 1 ? "" : "s"} just arrived`);
          setTimeout(() => setFresh(new Set()), 4000);
        }
      }
      known.current = ids;
      setFeed(f);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
    }
  }, [toast]);

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const r = await api<Record<string, string>>("/api/sync", { method: "POST" });
      const msg = r.ingest && !/not due|already/.test(r.ingest) ? `Sync done — ${r.ingest}` : "Sync done";
      toast(msg, /error|no .* key/i.test(r.ingest ?? ""));
      await refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSyncing(false);
    }
  }, [refresh, toast]);

  const openLead = useCallback((id: string | null, focus: "email" | "details" | null = null) => {
    setLeadId(id);
    setLeadFocus(focus);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("lead", id);
    else u.searchParams.delete("lead");
    window.history.replaceState(null, "", u.toString());
  }, []);

  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("lead");
    if (id) setLeadId(id);
    refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [refresh]);

  useEffect(() => {
    const n = (feed?.stats.unseen ?? 0) + (feed?.stats.unread_replies ?? 0);
    document.title = n ? `(${n}) NEXGEN` : "NEXGEN";
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [feed?.stats.unseen, feed?.stats.unread_replies]);

  return (
    <FeedCtx.Provider value={{ feed, error, updatedAt, refresh, syncing, sync, toast, toasts, openLead, leadId, leadFocus, fresh, search, setSearch }}>
      {stale && (
        <div className="update-bar" role="status">
          A new version of NEXGEN is live.
          <button className="btn sm primary" onClick={() => location.reload()}>
            Reload now
          </button>
        </div>
      )}
      {children}
    </FeedCtx.Provider>
  );
}
