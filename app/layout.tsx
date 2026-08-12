import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  description:
    "Fork Eve, connect iMessage and Coinbase, and deploy your own agent.",
  title: "Eve — launch your own agent",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#101010",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
