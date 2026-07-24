import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ExternalLink, ThumbsUp } from "lucide-react";
import { currentPrincipalFn, listAgentsFn, listObservabilityFn } from "@/lib/server";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/observability")({
  head: () => ({ meta: [{ title: "Observability · Latch" }] }),
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: async () => ({
    feed: await listObservabilityFn({ data: {} }),
    agents: await listAgentsFn(),
  }),
  component: ObservabilityPage,
});

type Feed = Awaited<ReturnType<typeof listObservabilityFn>>;

const POLL_MS = 5_000;

/** Format a score value for the feed (binary → ✓/✗, numeric → 2 decimals). */
function scoreLabel(s: { value: number | string | null; dataType?: string }): string {
  if (typeof s.value !== "number") return String(s.value ?? "—");
  if (s.dataType === "BOOLEAN") return s.value >= 1 ? "✓" : "✗";
  return s.value.toFixed(2);
}

function ObservabilityPage() {
  const initial = Route.useLoaderData();
  const [agent, setAgent] = useState<string>("");
  const [feed, setFeed] = useState<Feed>(initial.feed);

  // Live poll (~5s), paused while the tab is hidden — this is the "watch your
  // agent get judged in realtime" loop.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await listObservabilityFn({ data: { agent: agent || undefined } });
        if (!cancelled) setFeed(next);
      } catch {
        /* transient poll failure — next tick retries */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agent]);

  if (!feed.configured) {
    return (
      <div className="mx-auto max-w-5xl space-y-2 p-6">
        <h1 className="text-lg font-semibold">Observability</h1>
        <p className="text-muted-foreground text-sm">
          Langfuse isn't configured. Set <code>LANGFUSE_PUBLIC_KEY</code>,{" "}
          <code>LANGFUSE_SECRET_KEY</code> (and optionally{" "}
          <code>LANGFUSE_BASE_URL</code>) to trace runs, attach evals, and see
          scores here.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-lg font-semibold">Observability</h1>
        <div className="flex items-center gap-3">
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="bg-background h-8 rounded-md border px-2 text-sm"
          >
            <option value="">All agents</option>
            {initial.agents.map((a: { name: string; title?: string }) => (
              <option key={a.name} value={a.name}>
                {a.title ?? a.name}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground text-xs">live · {POLL_MS / 1000}s</span>
        </div>
      </div>

      {(feed.aggregates.length > 0 || feed.feedback) && (
        <div className="flex flex-wrap gap-2">
          {feed.feedback && (
            <Badge variant="secondary" className="gap-1">
              <ThumbsUp className="size-3" />
              {Math.round(feed.feedback.rate * 100)}% ({feed.feedback.count})
            </Badge>
          )}
          {feed.aggregates.map((a) => (
            <Badge key={a.name} variant="outline">
              {a.name}: {a.average.toFixed(2)} (n={a.count})
            </Badge>
          ))}
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead className="w-[28%]">Input</TableHead>
              <TableHead className="w-[28%]">Output</TableHead>
              <TableHead>Scores</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">When</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {feed.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground text-center text-sm">
                  No traces yet — chat with an agent and its run appears here
                  within seconds.
                </TableCell>
              </TableRow>
            )}
            {feed.rows.map((r) => (
              <TableRow key={r.traceId}>
                <TableCell className="whitespace-nowrap">{r.agent ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground max-w-0 truncate text-sm">
                  {r.inputPreview || "—"}
                </TableCell>
                <TableCell className="text-muted-foreground max-w-0 truncate text-sm">
                  {r.outputPreview || "—"}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {r.scores.length === 0 && (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                    {r.scores.map((s, i) => (
                      <Badge
                        key={`${s.name}-${i}`}
                        variant={
                          typeof s.value === "number" && s.value >= 0.5 ? "secondary" : "destructive"
                        }
                        title={s.comment}
                      >
                        {s.name} {scoreLabel(s)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.latencySeconds != null ? `${r.latencySeconds.toFixed(1)}s` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.cost != null ? `$${r.cost.toFixed(4)}` : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-sm whitespace-nowrap">
                  {new Date(r.timestamp).toLocaleTimeString()}
                </TableCell>
                <TableCell>
                  {r.deepLink && (
                    <a
                      href={r.deepLink}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open trace in Langfuse"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
