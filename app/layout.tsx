import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "pay — decentralized p2p payments",
  description:
    "Send money directly to anyone. No banks, no intermediaries, no custody of your funds.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0a0a0a",
          color: "#f5f5f5",
        }}
      >
        {children}
      </body>
    </html>
  );
}
