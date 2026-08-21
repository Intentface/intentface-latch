import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ExternalLink, ThumbsUp, EyeOff } from "lucide-react";
import {
  cachingStatsFn,
  currentPrincipalFn,
  listAgentsFn,
  listObservabilityFn,
} from "@/lib/server";
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
  loader: async () => {
    // Independent server fns — fetch concurrently. `caching` (per-agent hit
    // rate + lint, own runs, 7d) loads once; unlike the trace feed it moves
    // slowly, so it isn't polled.
    const [feed, agents, caching] = await Promise.all([
      listObservabilityFn({ data: {} }),
      listAgentsFn(),
      cachingStatsFn(),
    ]);
    return { feed, agents, caching };
  },
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
  // Narrow to one person's runs. Keyed by the server's opaque runner key, which
  // is a pseudonym while anonymized — so switching modes clears the selection
  // rather than silently filtering on a key the new mode never emits.
  const [runner, setRunner] = useState<string>("");
  const [anonymous, setAnonymous] = useState(false);
  const [feed, setFeed] = useState<Feed>(initial.feed);

  // Drop a runner filter once that person leaves the window — narrowing the agent
  // filter, or their runs simply ageing out, can unmount the dropdown while the
  // key is still selected. The table would then show "No traces yet" with no
  // control left to clear it.
  useEffect(() => {
    if (runner && !feed.runners.some((r) => r.key === runner)) setRunner("");
  }, [feed.runners, runner]);

  // Live poll (~5s), paused while the tab is hidden — this is the "watch your
  // agent get judged in realtime" loop.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const next = await listObservabilityFn({
          data: {
            agent: agent || undefined,
            runner: runner || undefined,
            anonymous: anonymous || undefined,
          },
        });
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
  }, [agent, runner, anonymous]);

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
          {/* Only worth showing once someone other than you has used an agent
              you administer — otherwise every row is "You". */}
          {feed.runners.length > 1 && (
            <select
              value={runner}
              onChange={(e) => setRunner(e.target.value)}
              className="bg-background h-8 rounded-md border px-2 text-sm"
              aria-label="Filter by who ran the agent"
            >
              <option value="">Everyone</option>
              {feed.runners.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => {
              // The runner keys differ between modes; drop the filter with them.
              setRunner("");
              setAnonymous((v) => !v);
            }}
            aria-pressed={anonymous}
            title={
              anonymous
                ? "Showing pseudonyms instead of names"
                : "Hide who ran each turn (names are not sent to the browser)"
            }
            className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-sm ${
              anonymous ? "bg-accent text-accent-foreground" : "bg-background"
            }`}
          >
            <EyeOff className="size-3.5" />
            Anonymize
          </button>
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

      {/* Prompt-caching health per agent (own runs, 7d): hit rate + lint rule
          badges — hover a rule code for the explanation. Respects the agent
          filter above. */}
      {initial.caching.agents.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">
            caching ({initial.caching.windowDays}d):
          </span>
          {initial.caching.agents
            .filter((c) => !agent || c.agent === agent)
            .map((c) => (
              <Badge key={c.agent} variant="outline" className="gap-1.5">
                {c.agent}: {(c.hitRate * 100).toFixed(0)}%
                {c.suggestions.map((s) => (
                  <span
                    key={s.rule}
                    title={s.message}
                    className={`cursor-help ${
                      s.severity === "warn"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s.rule}
                  </span>
                ))}
              </Badge>
            ))}
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Who</TableHead>
              <TableHead className="w-[26%]">Input</TableHead>
              <TableHead className="w-[26%]">Output</TableHead>
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
                <TableCell colSpan={9} className="text-muted-foreground text-center text-sm">
                  No traces yet — chat with an agent and its run appears here
                  within seconds.
                </TableCell>
              </TableRow>
            )}
            {feed.rows.map((r) => (
              <TableRow key={r.traceId}>
                <TableCell className="whitespace-nowrap">{r.agent ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {r.runner ? (
                    <span className={r.runner.isSelf ? "text-muted-foreground" : ""}>
                      {r.runner.label}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
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
                          // Categorical (string) scores are neutral, not failures;
                          // only a numeric value below 0.5 reads as "failed".
                          typeof s.value === "string" || (typeof s.value === "number" && s.value >= 0.5)
                            ? "secondary"
                            : "destructive"
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
