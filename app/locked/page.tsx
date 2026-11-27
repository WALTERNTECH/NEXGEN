export const metadata = { title: "NEXGEN" };

export default function Locked() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ padding: 28, maxWidth: 380, textAlign: "center" }}>
        <img src="/icons/icon-192.png" alt="" width={48} height={48} style={{ borderRadius: 12 }} />
        <h1 style={{ fontSize: 20, marginTop: 12 }}>NEXGEN</h1>
        <p className="sub" style={{ margin: "8px 0 0" }}>This dashboard opens from its private link. Open the link you were given and you'll go straight in.</p>
      </div>
    </div>
  );
}
