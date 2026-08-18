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
        {/* Fonts → tokens → base → marks → components, in that order. */}
        <link rel="stylesheet" href="/brand/css/index.css" />
        <link rel="icon" href="/brand/logo/favicon.svg" />
      </head>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
