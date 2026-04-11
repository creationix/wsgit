export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: "light dark" }}>
      <body style={{
        fontFamily: "system-ui, sans-serif",
        margin: 0,
        backgroundColor: "Canvas",
        color: "CanvasText",
      }}>{children}</body>
    </html>
  );
}
