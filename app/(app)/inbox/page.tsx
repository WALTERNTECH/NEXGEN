"use client";

import { Skeleton } from "@/components/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { useFeed } from "@/components/feed";
import { IWhatsApp, IReply } from "@/components/icons";
import { api, ago, CAT_COLOR, CAT_HEX, CAT_LABEL, waNumber, type Category } from "@/components/util";

interface Thread {
  lead_id: string;
  company_name: string;
  founder_full_name: string | null;
  direct_email: string | null;
  direct_mobile: string | null;
  category: Category;
  status: string;
  unread_replies: number;
  followups_sent: number;
  subject: string | null;
  body: string | null;
  received_at: string;
  from_email: string;
}

export default function InboxPage() {
  const { openLead, feed, toast, refresh } = useFeed();
  const [threads, setThreads] = useState<Thread[] | null>(null);

  const load = useCallback(() => api<{ threads: Thread[] }>("/api/inbox").then((r) => setThreads(r.threads)).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load, feed?.stats.unread_replies, feed?.stats.replied]);

  const followUp = async (t: Thread) => {
    try {
      await api(`/api/leads/${t.lead_id}`, { method: "POST", json: { action: "send", kind: "followup" } });
      toast(`Follow-up queued for ${t.company_name}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p>Replies from leads, pulled from your mailbox every minute. Open one to answer or send the follow-up.</p>
        </div>
      </div>
      {!feed?.health.mailbox && <div className="notice">Connect your mailbox in Settings so replies show up here.</div>}
      <div className="card">
        {!threads ? (
          <Skeleton rows={4} />
        ) : threads.length === 0 ? (
          <div className="empty">
            <b>No replies yet</b>
            When a lead answers one of your emails it appears here and on your phone.
          </div>
        ) : (
          threads.map((t) => (
            <div key={t.lead_id} className={`inbox-item ${t.unread_replies ? "unread" : ""}`} onClick={() => openLead(t.lead_id)}>
              <div className="avatar" style={{ background: CAT_HEX[t.category] }}>
                {(t.founder_full_name ?? t.company_name)
                  .split(" ")
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join("")}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                  <span className="who">
                    {t.founder_full_name ?? t.from_email} <span className="muted" style={{ fontWeight: 400 }}>· {t.company_name}</span>
                  </span>
                  <span className="small">{ago(t.received_at)}</span>
                </div>
                <div className="small" style={{ color: "var(--ink-2)", marginTop: 2 }}>
                  <span className="cat" style={{ marginRight: 6 }}>
                    <i style={{ background: CAT_COLOR[t.category] }} />
                    {CAT_LABEL[t.category]}
                  </span>
                  {t.subject}
                </div>
                <div style={{ marginTop: 4, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {t.body}
                </div>
                <div className="row" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                  {t.unread_replies > 0 && <span className="pill violet">{t.unread_replies} unread</span>}
                  {t.status === "unsubscribed" && <span className="pill red">Asked to stop</span>}
                  <button className="btn sm" onClick={() => openLead(t.lead_id)}>
                    <IReply />
                    Reply
                  </button>
                  {t.status !== "unsubscribed" && (
                    <button className="btn sm" onClick={() => followUp(t)}>
                      Send follow-up template
                    </button>
                  )}
                  {t.direct_mobile && (
                    <a className="btn sm" href={`https://wa.me/${waNumber(t.direct_mobile)}`} target="_blank" rel="noreferrer" style={{ color: "#128c4b" }}>
                      <IWhatsApp />
                      WhatsApp
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
