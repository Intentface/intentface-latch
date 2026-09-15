"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface Spend {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
}
interface Budget {
  spend: Spend;
  limit: number;
  key: string;
}

/** 12400 → "12.4k". Token counts are only useful at a glance. */
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export function SpendView({ limits }: { limits: { org: number; user: number } }) {
  const [data, setData] = useState<{ org: Budget; user: Budget } | null>(null);

  useEffect(() => {
    const load = () =>
      void fetch("/api/spend")
        .then((r) => r.json())
        .then(setData)
        .catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h2 className="text-sm font-medium tracking-tight">Spend</h2>
      <p className="mt-1 text-xs text-ink-tertiary">
        Read from the same ledger the ceilings are enforced against. The tighter ceiling stops a
        run, and the check happens before a step rather than after it.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <BudgetCard
          title="Organization"
          caption={`this month · ceiling $${limits.org.toFixed(2)}`}
          budget={data?.org}
        />
        <BudgetCard
          title="You"
          caption={`today · ceiling $${limits.user.toFixed(2)}`}
          budget={data?.user}
        />
      </div>

      <p className="mt-6 text-2xs text-ink-tertiary">
        Cached input is priced at the cache rate, roughly a tenth of fresh input. On a long
        conversation that share is most of the bill.
      </p>
    </div>
  );
}

function BudgetCard({
  title,
  caption,
  budget,
}: {
  title: string;
  caption: string;
  budget?: Budget;
}) {
  if (!budget)
    return <div className="h-28 animate-pulse rounded-xl bg-primary-bg shadow-border" />;

  const { spend, limit } = budget;
  const remaining = Math.max(0, limit - spend.cost);
  const used = Math.min(100, (spend.cost / limit) * 100);
  const reached = remaining === 0;
  const low = !reached && remaining < limit * 0.2;
  const cachedShare = spend.inputTokens
    ? Math.round((spend.cacheReadTokens / spend.inputTokens) * 100)
    : 0;

  return (
    <div className="rounded-xl bg-primary-bg px-4 py-3 shadow-border">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs font-medium">{title}</div>
          <div className="text-2xs text-ink-tertiary">{caption}</div>
        </div>
        <div className="text-right">
          <div
            className={cn(
              "font-mono text-sm",
              reached ? "text-red-500" : low ? "text-amber-500" : "text-ink-primary",
            )}
          >
            ${remaining.toFixed(4)}
          </div>
          <div className="text-2xs text-ink-tertiary">{reached ? "ceiling reached" : "left"}</div>
        </div>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded bg-quaternary-bg">
        <div
          className={cn(
            "h-full transition-[width]",
            reached ? "bg-red-500" : low ? "bg-amber-500" : "bg-accent-bg",
          )}
          style={{ width: `${used}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-4 gap-2 font-mono text-2xs">
        <Stat label="spent" value={`$${spend.cost.toFixed(4)}`} />
        <Stat label="in" value={compact(spend.inputTokens)} />
        <Stat label="out" value={compact(spend.outputTokens)} />
        <Stat
          label="cached"
          value={spend.cacheReadTokens ? `${compact(spend.cacheReadTokens)} · ${cachedShare}%` : "—"}
          accent={spend.cacheReadTokens > 0}
        />
      </dl>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-ink-tertiary">{label}</dt>
      <dd className={accent ? "text-accent-bg" : "text-ink-secondary"}>{value}</dd>
    </div>
  );
}
