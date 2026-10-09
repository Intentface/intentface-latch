import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SiteShell } from "@/components/site-shell";
import { source } from "@/lib/source";
import corePackage from "../../../packages/core/package.json";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  weight: "variable",
  subsets: ["latin"],
  display: "swap",
});

// Ioskeley Mono (OFL-1.1, github.com/ahatem/IoskeleyMono). Only the ligature
// build ships web fonts, so globals.css turns ligatures off for mono text.
const ioskeleyMono = localFont({
  variable: "--font-ioskeley-mono",
  src: [
    { path: "./fonts/IoskeleyMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IoskeleyMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IoskeleyMono-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Latch", template: "%s · Latch" },
  description:
    "The backend around your AI agent: saved conversations, approvals, crash recovery, per-customer isolation and usage limits, inside your own server and database.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${ioskeleyMono.variable} antialiased`} suppressHydrationWarning>
        <Providers>
          {/* Read here on the server, so only the version reaches the client. */}
          <SiteShell tree={source.getPageTree()} version={corePackage.version}>
            {children}
          </SiteShell>
        </Providers>
      </body>
    </html>
  );
}
