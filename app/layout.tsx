import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import ogImage from "./og.png";

const title = "Run trading agents from iMessage";
const description =
  "Deploy your own trading agent with a couple of clicks.";

export const metadata: Metadata = {
  description,
  metadataBase: new URL("https://adaam.vercel.app"),
  openGraph: {
    description,
    images: [
      {
        alt: "Run trading agents from iMessage",
        height: ogImage.height,
        url: ogImage.src,
        width: ogImage.width,
      },
    ],
    title,
    type: "website",
    url: "/",
  },
  title,
  twitter: {
    card: "summary_large_image",
    description,
    images: [ogImage.src],
    title,
  },
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
