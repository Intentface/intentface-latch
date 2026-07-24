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
  const [traces, scores] = await Promise.all([
    client.api.trace.list({
      userId: args.ownerTag,
      ...(args.agent ? { name: args.agent } : {}),
      limit,
      page: args.page,
      orderBy: "timestamp.desc",
    }),
    client.api.scores.getMany({ userId: args.ownerTag, limit: 100 }),
  ]);

  const scoresByTrace = new Map<string, TraceScore[]>();
  for (const s of scores.data ?? []) {
    const traceId = (s as { traceId?: string | null }).traceId;
    if (!traceId) continue;
    const list = scoresByTrace.get(traceId) ?? [];
    list.push({
      name: s.name,
      value: (s as { value?: number | string | null }).value ?? null,
      comment: s.comment ?? undefined,
      dataType: (s as { dataType?: string }).dataType,
    });
    scoresByTrace.set(traceId, list);
  }

  return (traces.data ?? []).map((t) => ({
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
