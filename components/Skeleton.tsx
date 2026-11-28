/**
 * What shows while a screen's data is on its way: the shape of the screen in moving placeholders,
 * so the wait reads as loading rather than a stall (same idea as Krypton's loading screen).
 */
export function Skeleton({ rows = 5, card = false }: { rows?: number; card?: boolean }) {
  const body = (
    <div className="page-in sk-wrap" aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 12, width: 96 }} />
      <div className="skeleton" style={{ height: 26, width: 220, marginTop: 10 }} />
      <div className="row" style={{ gap: 10, marginTop: 16 }}>
        <div className="skeleton" style={{ height: 38, flex: 1, borderRadius: 10 }} />
        <div className="skeleton" style={{ height: 38, flex: 1, borderRadius: 10 }} />
        <div className="skeleton" style={{ height: 38, flex: 1, borderRadius: 10 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="sk-row">
            <div className="skeleton" style={{ height: 36, width: 36, borderRadius: 999, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="skeleton" style={{ height: 13, width: "46%" }} />
              <div className="skeleton" style={{ height: 10, width: "28%", marginTop: 8 }} />
            </div>
            <div className="skeleton" style={{ height: 13, width: 70 }} />
            <div className="skeleton" style={{ height: 30, width: 80, borderRadius: 8 }} />
          </div>
        ))}
      </div>
    </div>
  );
  return card ? <div className="card card-b">{body}</div> : body;
}
