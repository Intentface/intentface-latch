import type { Client } from "@libsql/client";
import type { Pricing } from "@intentface/latch-core";

/**
 * Per-agent prompt-caching stats + deterministic lint suggestions for the
 * /caching page. Raw-SQL over `latch_runs`/`latch_chats`/`latch_usage` (same
 * convention as telegram-store: the platform's own tables, no drizzle adapter
 * obligation), scoped to the caller's own runs via `latch_chats.owner` exactly
 * like the adapter's `listRuns`.
 *
 * Scope filters: user-visible chats only (`kind = 'user'` — subagent/eval
 * threads are `internal` and single-run by construction), real conversational
 * turns only (`run.kind = 'turn'`; NULL = pre-migration rows, counted as
 * turns), and settled runs (`completed`/`awaiting_input`).
 *
 * All money numbers are labeled estimates: pre-feature rows have NULL cache
 * columns (read as 0), and the prefix-size lint estimates tokens from
 * character counts.
 */

/** Anthropic's default cache TTL — the window a follow-up turn must land in. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CachingSuggestion {
  rule: string;
  severity: "info" | "warn";
  message: string;
}

export interface AgentCachingStats {
  agent: string;
  runs: number;
  chats: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cache_read / total input — the headline number. */
  hitRate: number;
  costUsd: number;
  /** Estimated USD lost to unrecouped cache writes + missed cache reads. */
  estWasteUsd: number;
  medianGapMs: number | null;
  p90GapMs: number | null;
  /** Distinct non-NULL tools_hash values — >1 means the toolset churned. */
  distinctToolsets: number;
  /** Share of chats with exactly one run in the window. */
  singleRunChatShare: number;
  suggestions: CachingSuggestion[];
}

/** What the lint rules need to know about an agent's config. */
export interface AgentLintInput {
  name: string;
  modelId: string;
  instructions: string;
  memoryEnabled: boolean;
}

interface RunRow {
  agent: string;
  chatId: string;
  startedAt: number;
  endedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolsHash: string | null;
  model: string | null;
}

/**
 * Minimum cacheable prefix per Anthropic model family — below it, cache_control
 * markers silently no-op. Non-monotonic across generations, so a table, not a
 * range. OpenAI's automatic caching needs 1024, which the default also covers.
 */
export function minCacheablePrefixTokens(modelId: string): number {
  const id = modelId.toLowerCase();
  if (/fable-5|mythos-5|opus-5/.test(id)) return 512;
  if (/haiku-4-5|opus-4-5|opus-4-6/.test(id)) return 4096;
  if (/opus-4-7|haiku-3-5/.test(id)) return 2048;
  return 1024;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

export function createCachingStats(deps: { client: Client; pricing: Pricing }) {
  const { client, pricing } = deps;

  async function loadRuns(ownerKey: string, sinceMs: number): Promise<RunRow[]> {
    // Inner select: cap by RECENCY (a flat LIMIT on the chat-ordered rows
    // would drop whole recent chats once the window overflows). Usage join is
    // grouped to one row per run — run_id isn't unique in latch_usage, and a
    // duplicate row there must not double-count the run.
    const res = await client.execute({
      sql: `SELECT r.agent AS agent, r.chat_id AS chat_id, r.started_at AS started_at,
                   r.ended_at AS ended_at,
                   COALESCE(r.usage_input_tokens, 0) AS input_tokens,
                   COALESCE(r.usage_output_tokens, 0) AS output_tokens,
                   COALESCE(r.usage_cache_read_tokens, 0) AS cache_read,
                   COALESCE(r.usage_cache_write_tokens, 0) AS cache_write,
                   COALESCE(r.cost_total, 0) AS cost,
                   r.tools_hash AS tools_hash, u.model AS model
            FROM (
              SELECT r.* FROM latch_runs r
              JOIN latch_chats c ON c.id = r.chat_id
              WHERE c.owner = ? AND c.kind = 'user'
                AND COALESCE(r.kind, 'turn') = 'turn'
                AND r.status IN ('completed', 'awaiting_input')
                AND r.started_at >= ?
              ORDER BY r.started_at DESC
              LIMIT 20000
            ) r
            LEFT JOIN (
              SELECT run_id, MIN(model) AS model FROM latch_usage GROUP BY run_id
            ) u ON u.run_id = r.id
            ORDER BY r.chat_id, r.started_at`,
      args: [ownerKey, sinceMs],
    });
    return res.rows.map((row) => ({
      agent: String(row.agent),
      chatId: String(row.chat_id),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at == null ? null : Number(row.ended_at),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      cost: Number(row.cost),
      toolsHash: row.tools_hash == null ? null : String(row.tools_hash),
      model: row.model == null ? null : String(row.model),
    }));
  }

  /** Aggregate per-agent stats over the caller's runs in the window. */
  async function statsFor(input: {
    ownerKey: string;
    windowDays?: number;
    /** Agent configs for the lint rules (from agentStore.listRecords). */
    agents?: AgentLintInput[];
  }): Promise<AgentCachingStats[]> {
    const windowDays = input.windowDays ?? 7;
    const rows = await loadRuns(input.ownerKey, Date.now() - windowDays * 86_400_000);

    interface Acc {
      runs: number;
      input: number;
      output: number;
      read: number;
      write: number;
      cost: number;
      wasteUsd: number;
      gaps: number[];
      toolsets: Set<string>;
      chatRunCounts: Map<string, number>;
    }
    const byAgent = new Map<string, Acc>();
    const acc = (agent: string): Acc => {
      let a = byAgent.get(agent);
      if (!a) {
        a = {
          runs: 0,
          input: 0,
          output: 0,
          read: 0,
          write: 0,
          cost: 0,
          wasteUsd: 0,
          gaps: [],
          toolsets: new Set(),
          chatRunCounts: new Map(),
        };
        byAgent.set(agent, a);
      }
      return a;
    };

    // Rows arrive ordered by (chat, started_at), so adjacency within a chat is
    // adjacency in the array.
    for (let i = 0; i < rows.length; i++) {
      const run = rows[i]!;
      const a = acc(run.agent);
      a.runs += 1;
      a.input += run.inputTokens;
      a.output += run.outputTokens;
      a.read += run.cacheRead;
      a.write += run.cacheWrite;
      a.cost += run.cost;
      if (run.toolsHash) a.toolsets.add(run.toolsHash);
      a.chatRunCounts.set(run.chatId, (a.chatRunCounts.get(run.chatId) ?? 0) + 1);

      const prev = i > 0 && rows[i - 1]!.chatId === run.chatId ? rows[i - 1]! : null;
      const next = i + 1 < rows.length && rows[i + 1]!.chatId === run.chatId ? rows[i + 1]! : null;
      if (prev) a.gaps.push(run.startedAt - (prev.endedAt ?? prev.startedAt));

      const price = run.model ? pricing(run.model) : undefined;
      if (price) {
        const inputRate = price.inputPer1M;
        const readRate = price.cacheReadPer1M ?? inputRate;
        const writeRate = price.cacheWritePer1M ?? inputRate;
        // Unrecouped write: this run wrote cache no later run read (no
        // successor in the chat inside the TTL) — the write premium was wasted.
        const nextGap = next ? next.startedAt - (run.endedAt ?? run.startedAt) : null;
        if (run.cacheWrite > 0 && (nextGap === null || nextGap > CACHE_TTL_MS)) {
          a.wasteUsd += (run.cacheWrite * Math.max(0, writeRate - inputRate)) / 1e6;
        }
        // Missed read: the predecessor ended inside the TTL but nothing was
        // read — the prefix re-billed at the full input rate.
        const prevGap = prev ? run.startedAt - (prev.endedAt ?? prev.startedAt) : null;
        if (prevGap !== null && prevGap <= CACHE_TTL_MS && run.cacheRead === 0 && run.inputTokens > 0) {
          const uncached = Math.max(0, run.inputTokens - run.cacheWrite);
          a.wasteUsd += (uncached * Math.max(0, inputRate - readRate)) / 1e6;
        }
      }
    }

    const agentConfigs = new Map((input.agents ?? []).map((a) => [a.name, a]));
    return [...byAgent.entries()]
      .map(([agent, a]) => {
        const gaps = [...a.gaps].sort((x, y) => x - y);
        const chats = a.chatRunCounts.size;
        const singleRunChats = [...a.chatRunCounts.values()].filter((n) => n === 1).length;
        const stats: AgentCachingStats = {
          agent,
          runs: a.runs,
          chats,
          inputTokens: a.input,
          outputTokens: a.output,
          cacheReadTokens: a.read,
          cacheWriteTokens: a.write,
          hitRate: a.input > 0 ? a.read / a.input : 0,
          costUsd: a.cost,
          estWasteUsd: a.wasteUsd,
          medianGapMs: percentile(gaps, 0.5),
          p90GapMs: percentile(gaps, 0.9),
          distinctToolsets: a.toolsets.size,
          singleRunChatShare: chats > 0 ? singleRunChats / chats : 0,
          suggestions: [],
        };
        stats.suggestions = lintAgentCaching(stats, agentConfigs.get(agent));
        return stats;
      })
      .sort((x, y) => y.costUsd - x.costUsd);
  }

  return { statsFor };
}

/** Heuristic for "dynamic-looking" content baked into static instructions. */
const DYNAMIC_CONTENT = [
  /\b\d{4}-\d{2}-\d{2}\b/, // an ISO date snapshot
  /\$\{|\{\{/, // unrendered template placeholders
  /\bcurrent (time|date)\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
];

/**
 * Deterministic caching lint (R1–R8). Rules read only measured stats + the
 * agent's stored config — no LLM, so every suggestion is explainable and
 * testable. Thresholds are advisory heuristics, tuned for "worth a look".
 */
export function lintAgentCaching(
  stats: AgentCachingStats,
  agent?: AgentLintInput,
): CachingSuggestion[] {
  const out: CachingSuggestion[] = [];
  const fastTurns = stats.medianGapMs !== null && stats.medianGapMs <= CACHE_TTL_MS;
  const lowHitRate = stats.runs >= 10 && stats.hitRate < 0.4;

  if (agent) {
    // R1 — dynamic-looking content in instructions.
    if (DYNAMIC_CONTENT.some((re) => re.test(agent.instructions))) {
      out.push({
        rule: "R1",
        severity: "warn",
        message:
          "Instructions contain dynamic-looking content (a date, template placeholder, or UUID). If it changes between edits, every change invalidates the cached system prompt — move volatile facts into tools or the conversation.",
      });
    }
  }
  // R2 — turns arrive slower than the cache TTL.
  if (stats.medianGapMs !== null && stats.medianGapMs > CACHE_TTL_MS) {
    out.push({
      rule: "R2",
      severity: "info",
      message: `Median time between turns (${Math.round(stats.medianGapMs / 60000)}m) exceeds the 5-minute cache TTL — cross-turn caching can't pay here. In-turn tool loops still benefit; a 1h-TTL cache (2× write cost) is the lever if cross-turn reuse matters.`,
    });
  }
  // R3 — turns are fast enough but the cache isn't hitting: prefix instability.
  if (lowHitRate && fastTurns) {
    out.push({
      rule: "R3",
      severity: "warn",
      message: `Hit rate is ${(stats.hitRate * 100).toFixed(0)}% despite turns landing inside the TTL — something is changing the prompt prefix between requests.`,
    });
  }
  // R4 — the toolset itself churned across runs.
  if (stats.distinctToolsets > 1) {
    out.push({
      rule: "R4",
      severity: "warn",
      message: `${stats.distinctToolsets} distinct toolsets across recent runs — tool definitions changed between turns (an MCP server dropping tools, connect_* gates toggling with auth state, or subagent lists shifting), which invalidates the whole prompt cache.`,
    });
  }
  // R5 — writes that never get read back.
  if (stats.cacheWriteTokens > 0 && stats.cacheReadTokens / stats.cacheWriteTokens < 0.5) {
    out.push({
      rule: "R5",
      severity: "warn",
      message:
        "Cache writes exceed reads 2:1 — the write premium is being paid without the payoff. Usually follow-up turns landing after the TTL (see the turn-gap column) or a prefix that changes before it's reused.",
    });
  }
  // R6 — prefix likely below the model's cacheable minimum.
  if (agent) {
    const estPrefixTokens = Math.ceil(agent.instructions.length / 4);
    const min = minCacheablePrefixTokens(agent.modelId);
    if (estPrefixTokens < min) {
      out.push({
        rule: "R6",
        severity: "info",
        message: `Instructions are ~${estPrefixTokens} tokens; ${agent.modelId} caches nothing under ${min}. Tool definitions count toward the minimum too, so a toolful agent may still clear it — but a small, tool-light agent silently never caches.`,
      });
    }
  }
  // R7 — one-shot conversations can't recoup the write premium.
  if (stats.chats >= 5 && stats.singleRunChatShare > 0.8) {
    out.push({
      rule: "R7",
      severity: "info",
      message: `${Math.round(stats.singleRunChatShare * 100)}% of chats have a single turn — cross-turn cache writes have nothing to read them (in-turn tool-loop caching still applies).`,
    });
  }
  // R8 — memory rewrites the system block mid-conversation.
  if (agent?.memoryEnabled && lowHitRate && fastTurns && stats.distinctToolsets <= 1) {
    out.push({
      rule: "R8",
      severity: "info",
      message:
        "Memory is enabled and the toolset is stable, yet the hit rate is low with fast turns — memory-index writes are likely rewriting the system prompt between turns. The tools breakpoint keeps tool definitions cached; a static/memory system split would recover the rest.",
    });
  }
  return out;
}
