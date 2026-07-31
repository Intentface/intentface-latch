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
  /** The trace's Langfuse `userId` — the owner tag of whoever RAN the turn. */
  userId?: string;
  /** The `agent-owner:` tag, when the run's agent had an owner key. */
  agentOwner?: string;
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

/** The `agent-owner:` tag prefix — written by telemetry, filtered on here. */
export const AGENT_OWNER_TAG = "agent-owner:";

/** A trace row as the list API returns it (only the fields we surface). */
interface RawTrace {
  id: string;
  name?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  timestamp: string;
  tags?: string[] | null;
  input?: unknown;
  output?: unknown;
  latency?: number | null;
  totalCost?: number | null;
  htmlPath?: string;
  environment?: string;
}

/**
 * Scores for exactly these traces via the Scores v3 API (`scores.getMany`/v2 is
 * deprecated and 404s on Langfuse v4+). The v3 endpoint takes a comma-separated
 * `traceId` filter and returns the subject trace under `subject` when requested
 * via `fields`, so scores reliably attach to the traces we asked about instead of
 * a fixed 100-row owner-wide slice.
 */
async function scoresFor(traceIds: string[]): Promise<Map<string, TraceScore[]>> {
  const scoresByTrace = new Map<string, TraceScore[]>();
  if (traceIds.length === 0) return scoresByTrace;
  const client = getLangfuseClient();
  const traceIdFilter = traceIds.join(",");
  // `getManyV3` is cursor-paginated (max 100/page). A single page of traces can
  // carry >100 scores (rubrics + feedback per run), so follow the cursor until
  // it's absent — otherwise later scores silently drop off the feed.
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
  return scoresByTrace;
}

const toSummary = (t: RawTrace, scores: TraceScore[]): TraceSummary => ({
  id: t.id,
  runId: tagValue(t.tags ?? [], "run:"),
  agent: t.name ?? tagValue(t.tags ?? [], "agent:"),
  userId: t.userId ?? undefined,
  agentOwner: tagValue(t.tags ?? [], AGENT_OWNER_TAG),
  timestamp: t.timestamp,
  sessionId: t.sessionId ?? undefined,
  input: t.input,
  output: t.output,
  latency: t.latency ?? undefined,
  totalCost: t.totalCost ?? undefined,
  htmlPath: t.htmlPath,
  environment: t.environment,
  scores,
});

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
  const traces = await client.api.trace.list({
    userId: args.ownerTag,
    ...(args.agent ? { name: args.agent } : {}),
    limit: args.limit ?? 50,
    page: args.page,
    orderBy: "timestamp.desc",
  });
  const rows = (traces.data ?? []) as RawTrace[];
  const scores = await scoresFor(rows.map((t) => t.id));
  return rows.map((t) => toSummary(t, scores.get(t.id) ?? []));
}

/** Newest-first by trace timestamp; unparseable timestamps sort last. */
const byNewest = (a: RawTrace, b: RawTrace): number => {
  const at = Date.parse(a.timestamp);
  const bt = Date.parse(b.timestamp);
  return (Number.isNaN(bt) ? -Infinity : bt) - (Number.isNaN(at) ? -Infinity : at);
};

/**
 * The observability feed for a reader who administers agents: every recent run of
 * the agents owned by `agentOwnerTags` — INCLUDING runs by other users — unioned
 * with the reader's own runs (`ownerTag`).
 *
 * Two sources, because they answer different questions. The `agent-owner:` tag
 * finds other people's runs on my agents (the point of this feed). `ownerTag`
 * keeps my own runs visible on agents I don't administer — code-registry agents
 * carry no owner tag at all — and covers every trace written before the tag
 * existed. The API's `tags` filter is conjunctive ("all of these tags"), so each
 * owner key needs its own query; results are merged and de-duplicated by trace id.
 *
 * Tenancy: `agentOwnerTags` and `ownerTag` together ARE the boundary. Pass only
 * keys the caller provably holds (see `evalOwnerKeysOf`) — never a client value.
 */
export async function listAdministeredTraces(args: {
  /** Owner keys of the agents the reader administers (personal + org). */
  agentOwnerTags: string[];
  /** The reader's own owner tag, so its own runs stay visible. */
  ownerTag: string;
  /** Optional agent-name filter. */
  agent?: string;
  limit?: number;
}): Promise<TraceSummary[]> {
  const client = getLangfuseClient();
  const limit = args.limit ?? 50;
  const common = {
    ...(args.agent ? { name: args.agent } : {}),
    limit,
    orderBy: "timestamp.desc",
  };
  // De-duplicate the key list first: for a principal without a userId the
  // personal and org keys collapse to the same string, which would double the
  // API calls for identical rows.
  const ownerTags = [...new Set(args.agentOwnerTags.filter((t) => t.length > 0))];
  // Sources are independent and best-effort: one failing query (a transient 5xx,
  // or a deployment whose API rejects the tag filter) degrades the feed to the
  // other sources rather than emptying the page.
  const pages = await Promise.allSettled([
    ...ownerTags.map((tag) =>
      client.api.trace.list({ ...common, tags: [`${AGENT_OWNER_TAG}${tag}`] }),
    ),
    client.api.trace.list({ ...common, userId: args.ownerTag }),
  ]);

  const merged = new Map<string, RawTrace>();
  for (const page of pages) {
    if (page.status === "rejected") {
      console.warn("trace list source failed:", page.reason);
      continue;
    }
    for (const t of (page.value.data ?? []) as RawTrace[]) merged.set(t.id, t);
  }
  // Each source returned up to `limit` rows; the union can exceed it, so re-sort
  // across sources and take the newest `limit` — otherwise the cap would depend
  // on which query a row came from.
  const rows = [...merged.values()].sort(byNewest).slice(0, limit);
  const scores = await scoresFor(rows.map((t) => t.id));
  return rows.map((t) => toSummary(t, scores.get(t.id) ?? []));
}
