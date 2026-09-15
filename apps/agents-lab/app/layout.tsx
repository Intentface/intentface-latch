import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Lab",
  description: "A workbench for the experimental agents-sdk",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-base-bg text-ink-primary antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
