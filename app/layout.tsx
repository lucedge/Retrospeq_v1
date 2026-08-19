import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retrospeq",
  description: "Was this a good decision? Not: did this trade make money?",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* Fonts → tokens → base → marks → components, in that order.
            Manual <link> is intentional — the design system's own
            documented "no build step" integration contract (see
            AGENTS.md "Design system"), not something to switch to a
            next/font-style import. */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/brand/css/index.css" />
        <link rel="icon" href="/brand/logo/favicon.svg" />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
