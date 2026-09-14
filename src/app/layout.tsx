import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Signal Desk — scan, score, size, route (simulated)",
  description:
    "A market-research pipeline: live exchange data, LLM scoring under a strict schema, tested position sizing, and a simulated routing audit trail. No orders are placed.",
};

const NAV = [
  { href: "/", label: "Desk" },
  { href: "/runs", label: "Audit trail" },
  { href: "/about", label: "What's real" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-desk-950 text-ink-50">
        <a href="#main" className="skip-link bg-accent text-desk-950 px-3 py-2 font-medium">
          Skip to main content
        </a>

        {/*
          The simulation banner is part of the layout, not a page. It cannot be
          missed by navigating, and it is a <strong> inside a role="note" so a
          screen reader announces it as emphasised standing information rather
          than decoration.
        */}
        <div
          role="note"
          className="bg-warn/15 border-b border-warn/40 px-4 py-2 text-center text-sm text-warn"
        >
          <strong className="font-semibold">Simulation.</strong>{" "}
          No orders are placed, no funds move, no wallet is connected. Not financial advice.
        </div>

        <header className="border-b border-desk-700 bg-desk-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              Signal<span className="text-accent">Desk</span>
            </Link>
            <nav aria-label="Primary" className="flex gap-4 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-ink-300 hover:text-ink-50 underline-offset-4 hover:underline"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <p className="ml-auto text-xs text-ink-500">
              scan → score → size → route
            </p>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
          {children}
        </main>

        <footer className="border-t border-desk-700 bg-desk-900 px-4 py-4">
          <div className="mx-auto max-w-6xl text-xs text-ink-500">
            Built by Segun Olaniyan. Market data from Binance public endpoints;
            on-chain reads are read-only via a public RPC. Execution is simulated
            throughout —{" "}
            <Link href="/about" className="text-accent underline underline-offset-4">
              what is real and what is not
            </Link>
            .
          </div>
        </footer>
      </body>
    </html>
  );
}
