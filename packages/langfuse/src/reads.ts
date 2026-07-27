import { getLangfuseClient } from "./client.js";

export interface TraceScore {
  name: string;
  value: number | string | null;
  comment?: string;
  dataType?: string;
}

export interface TraceSummary {
  /** Langfuse trace id. */
  id: string;
  /** The latch run id (parsed from the `run:` tag), if present. */
  runId?: string;
  /** Agent name (the trace name / `agent:` tag). */
  agent?: string;
  timestamp: string;
  sessionId?: string;
  input?: unknown;
  output?: unknown;
  /** Latency in seconds. */
  latency?: number;
  /** Total cost in USD. */
  totalCost?: number;
  /** Deep link into the Langfuse UI. */
  htmlPath?: string;
  environment?: string;
  scores: TraceScore[];
}

const tagValue = (tags: string[], prefix: string): string | undefined =>
  tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

/**
 * Recent traces for one owner (tenant), newest first, with their scores
 * joined in. Reads are meant to run server-side in the platform — the owner
 * filter is the tenancy boundary, so never expose this to callers who don't
 * own `ownerTag`.
 */
export async function listOwnerTraces(args: {
  ownerTag: string;
  /** Optional agent-name filter. */
  agent?: string;
  limit?: number;
  page?: number;
}): Promise<TraceSummary[]> {
  const client = getLangfuseClient();
  const limit = args.limit ?? 50;
  const traces = await client.api.trace.list({
    userId: args.ownerTag,
    ...(args.agent ? { name: args.agent } : {}),
    limit,
    page: args.page,
    orderBy: "timestamp.desc",
  });
  const traceRows = traces.data ?? [];

  // Fetch scores for exactly this page's traces via the Scores v3 API
  // (`scores.getMany`/v2 is deprecated and 404s on Langfuse v4+). The v3
  // endpoint takes a comma-separated `traceId` filter and returns the subject
  // trace under `subject` when requested via `fields`, so scores reliably
  // attach to the current page instead of a fixed 100-row owner-wide slice.
  const scoresByTrace = new Map<string, TraceScore[]>();
  if (traceRows.length > 0) {
    const traceIdFilter = traceRows.map((t) => t.id).join(",");
    // `getManyV3` is cursor-paginated (max 100/page). A single page of traces
    // can carry >100 scores (rubrics + feedback per run), so follow the cursor
    // until it's absent — otherwise later scores silently drop off the feed.
    let cursor: string | undefined;
    do {
      const scores = await client.api.scoresV3.getManyV3({
        traceId: traceIdFilter,
        fields: "details,subject",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const s of scores.data ?? []) {
        const subject = (s as { subject?: { kind?: string; id?: string } }).subject;
        if (subject?.kind !== "trace" || !subject.id) continue;
        const list = scoresByTrace.get(subject.id) ?? [];
        // v3 returns BOOLEAN scores as a JS boolean (v2 returned 1/0). Normalize
        // to a number so binary and numeric scores share one numeric contract
        // (aggregates/averaging); categorical scores stay strings.
        const raw = (s as { value?: number | string | boolean | null }).value;
        const value = typeof raw === "boolean" ? (raw ? 1 : 0) : (raw ?? null);
        list.push({
          name: s.name,
          value,
          comment: s.comment ?? undefined,
          dataType: (s as { dataType?: string }).dataType,
        });
        scoresByTrace.set(subject.id, list);
      }
      cursor = scores.meta?.cursor;
    } while (cursor);
  }

  return traceRows.map((t) => ({
    id: t.id,
    runId: tagValue(t.tags ?? [], "run:"),
    agent: t.name ?? tagValue(t.tags ?? [], "agent:"),
    timestamp: t.timestamp,
    sessionId: t.sessionId ?? undefined,
    input: t.input,
    output: t.output,
    latency: t.latency ?? undefined,
    totalCost: t.totalCost ?? undefined,
    htmlPath: t.htmlPath,
    environment: t.environment,
    scores: scoresByTrace.get(t.id) ?? [],
  }));
}
