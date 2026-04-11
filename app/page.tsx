export default function Home() {
  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>ws-git</h1>
      <p>WebSocket git object sync protocol server.</p>
      <p>
        Use{" "}
        <code style={{
          background: "color-mix(in srgb, currentColor 12%, transparent)",
          padding: "0.15em 0.4em",
          borderRadius: 4,
          fontSize: "0.9em",
        }}>wsgit://</code>{" "}
        URLs to push and fetch.
      </p>
    </main>
  );
}
