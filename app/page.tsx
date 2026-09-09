// Placeholder landing page. The wallet, identity, and transport layers
// described in docs/ARCHITECTURE.md are not implemented yet.

const principles = [
  {
    title: "No custody",
    body: "The app never holds your money or your keys. Lose neither, trust no one.",
  },
  {
    title: "No accounts",
    body: "Identity is a public key, not a row in someone's database.",
  },
  {
    title: "No permission",
    body: "Anyone can receive. Nobody can be de-platformed.",
  },
  {
    title: "Portable",
    body: "Your history and contacts live on your device, exportable anytime.",
  },
];

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "3rem 1.5rem",
        maxWidth: "720px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ fontSize: "3.5rem", margin: "0 0 1rem" }}>pay</h1>
      <p style={{ fontSize: "1.25rem", color: "#a3a3a3", textAlign: "center" }}>
        Decentralized peer-to-peer payments. Send money directly to anyone —
        no banks, no intermediaries, no custody.
      </p>
      <p
        style={{
          marginTop: "2rem",
          padding: "0.75rem 1.25rem",
          border: "1px solid #333",
          borderRadius: "8px",
          color: "#d4d4d4",
          fontSize: "0.9rem",
        }}
      >
        Pre-alpha: vision and architecture are documented in{" "}
        <code>docs/</code>. The app itself is a scaffold — wallet, identity,
        and transport layers are not implemented yet.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "1rem",
          marginTop: "2.5rem",
          width: "100%",
        }}
      >
        {principles.map((p) => (
          <div
            key={p.title}
            style={{
              border: "1px solid #262626",
              borderRadius: "12px",
              padding: "1.25rem",
            }}
          >
            <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>
              {p.title}
            </h2>
            <p style={{ color: "#a3a3a3", margin: 0, fontSize: "0.95rem" }}>
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
