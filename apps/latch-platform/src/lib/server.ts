import { createServerFn } from "@tanstack/react-start";
import type { AppMessage } from "@intentface/latch-core";
import {
  slackManifest,
  createFromManifestUrl,
  SLACK_BOT_SCOPES,
} from "@intentface/latch-channels/slack";
import {
  isLangfuseConfigured,
  listOwnerTraces,
  postScore,
} from "@intentface/latch-langfuse";
import { getPrincipal } from "./session";
import { getLatch, ownerTagOf } from "./latch";
import { normalizeAgentName } from "./agent-store";
import type { AttachedEval } from "./agent-store";
import { validateRubrics } from "./observability/rubrics";
import { rejudgeRun } from "./observability/judge-run";
import {
  slackVaultKeys,
  SLACK_CONFIG_TOKEN_KEY,
  SLACK_CONFIG_REFRESH_KEY,
} from "./slack-store";
import { createAppFromManifest } from "./slack-admin";
import { baseUrl } from "./base-url";
import type { CredentialScope } from "./credentials";

/** API-key connections (REST/OpenAPI) and their credential scope, for the key UI. */
const API_KEY_CONNECTIONS: { name: string; label: string; scope: CredentialScope }[] = [];

/**
 * Server-only reads for SSR route loaders / auth gates. These are thin
 * pass-throughs to the in-process runtime (the framework does the work) — the
 * idiomatic TanStack way to render server-side, not per-endpoint Latch glue.
 * All Latch *operations* (chat, approvals, connections) go through the mounted
 * handler via `latch-client`, not here.
 */

/** Auth gate: the current principal, or null. */
export const currentPrincipalFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const p = await getPrincipal();
    return p ? { orgId: p.orgId, userId: p.userId } : null;
  },
);

/**
 * Recent chats for the sidebar — deliberately lightweight: a capped `listChats`
 * with NO per-chat cost (the run scan below is what made this slow, and the
 * sidebar only renders title/agent). Buffer a few extra rows so subagent
 * threads (`sub_…`) can be filtered out and still leave ~10 real chats.
 */
export const recentChatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const chats = await runtime.listChats({ principal, limit: 25 });
  return chats
    .filter((c) => !c.id.startsWith("sub_"))
    .slice(0, 10)
    .map((c) => ({ id: c.id, title: c.title ?? null, agent: c.agent }));
});

/** The tenant's chats for the chat-list page (includes per-chat cost totals). */
export const listChatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const chats = await runtime.listChats({ principal });
  // Sum each chat's run costs (incl. nested sub_… runs) for a per-chat total.
  const runs = await runtime.listRuns({ principal, limit: 1000 });
  const costByChat = new Map<string, number>();
  for (const r of runs) {
    costByChat.set(r.chatId, (costByChat.get(r.chatId) ?? 0) + (r.costTotal ?? 0));
  }
  // Subagent threads (`sub_…`) are nested under their parent's spawn_agent tool
  // calls, not top-level chats — keep them out of the list.
  return chats
    .filter((c) => !c.id.startsWith("sub_"))
    .map((c) => ({
      id: c.id,
      title: c.title ?? null,
      agent: c.agent,
      updatedAt: c.updatedAt,
      cost: costByChat.get(c.id) ?? 0,
    }));
});

/** The tenant's runs (status, tokens, cost) for the ops panel. */
export const listRunsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const runs = await runtime.listRuns({ principal });
  return runs.map((r) => ({
    id: r.id,
    chatId: r.chatId,
    agent: r.agent,
    status: r.status,
    inputTokens: r.usageInputTokens ?? 0,
    outputTokens: r.usageOutputTokens ?? 0,
    cacheReadTokens: r.usageCacheReadTokens ?? 0,
    cacheWriteTokens: r.usageCacheWriteTokens ?? 0,
    cost: r.costTotal ?? 0,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
  }));
});

/** Client-projected history for one chat (useChat initial messages). */
export const loadHistoryFn = createServerFn({ method: "GET" })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return [] as AppMessage[];
    const { runtime } = await getLatch();
    const messages = await runtime.loadHistory({ chatId, principal });
     
    return messages as any;
  });

/** Whether a chat has an in-flight (server-side) turn — drives the "generating"
 * indicator when a page reload lands on a still-running turn. */
export const chatGeneratingFn = createServerFn({ method: "GET" })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return false;
    const { runtime } = await getLatch();
    const runs = await runtime.listRuns({ principal });
    return runs.some((r) => r.chatId === chatId && r.status === "active");
  });

/** Per-connection status for the Connections page. */
export const connectionsStatusFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections } = await getLatch();
    return connections.status(principal);
  },
);

/** API-key connection status (is a key stored for the caller, at its scope). */
export const connectionKeysFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { credentials } = await getLatch();
  return Promise.all(
    API_KEY_CONNECTIONS.map(async (c) => ({
      name: c.name,
      label: c.label,
      scope: c.scope,
      set: await credentials.has(principal, c.name, c.scope),
    })),
  );
});

/** Store an API key for a connection, at its declared scope (user/org). */
export const setConnectionKeyFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; value: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const conn = API_KEY_CONNECTIONS.find((c) => c.name === data.name);
    if (!conn) return { ok: false };
    const { credentials } = await getLatch();
    await credentials.set(principal, conn.name, conn.scope, data.value);
    return { ok: true };
  });

/** UI-added connections visible to the caller (org-shared + personal). */
export const listConnectionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { connectionStore, dynamic } = await getLatch();
  const conns = await connectionStore.list(principal);
  // OAuth status for MCP connections (whether the caller has authorized).
  const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
  // Never return the token to the client — just shape + whether auth is set.
  return conns.map((c) => ({
    name: c.name,
    kind: c.kind,
    scope: c.scope,
    target: c.mcp?.url ?? c.openapi?.spec ?? "",
    hasAuth: c.auth?.kind === "bearer" || c.auth?.kind === "header",
    oauth: c.auth?.kind === "oauth",
    authorized: status.get(c.name)?.authorized ?? true,
  }));
});

/** Add a UI-defined connection (stored encrypted in the Vault at its scope). */
export const addConnectionFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      kind: "mcp" | "openapi";
      scope: "user" | "org";
      url?: string;
      spec?: string;
      baseUrl?: string;
      operations?: string;
      /** MCP only: "oauth" uses the interactive flow (no token); else token/none. */
      authMode?: "none" | "token" | "oauth";
      authHeader?: string;
      token?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = data.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!name) return { ok: false, error: "name required" };
    const auth =
      data.kind === "mcp" && data.authMode === "oauth"
        ? ({ kind: "oauth" } as const)
        : data.token?.trim()
          ? {
              kind: (data.authHeader?.trim() ? "header" : "bearer") as "header" | "bearer",
              header: data.authHeader?.trim() || undefined,
              token: data.token.trim(),
            }
          : undefined;
    const { connectionStore } = await getLatch();
    if (data.kind === "mcp") {
      if (!data.url?.trim()) return { ok: false, error: "url required" };
      await connectionStore.add(principal, data.scope, { kind: "mcp", name, mcp: { url: data.url.trim() }, auth });
    } else {
      if (!data.spec?.trim()) return { ok: false, error: "spec required" };
      const operations = data.operations
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await connectionStore.add(principal, data.scope, {
        kind: "openapi",
        name,
        openapi: {
          spec: data.spec.trim(),
          baseUrl: data.baseUrl?.trim() || undefined,
          operations: operations && operations.length > 0 ? operations : undefined,
        },
        auth,
      });
    }
    return { ok: true };
  });

/** Remove a UI-defined connection at its scope. */
export const removeConnectionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { connectionStore } = await getLatch();
    await connectionStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The agents available to the caller (code + UI-created), for the picker. */
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  return runtime.listAgents(principal);
});

/** The model catalog (id + label) for the agent editor's dropdown (from models.dev). */
export const listModelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { models } = await getLatch();
  return models;
});

/** Full UI-created agent records (org + personal), for the editor. */
export const listAgentRecordsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { agentStore } = await getLatch();
  return agentStore.listRecords(principal);
});

/** Connection names an agent can reference (code-declared + the caller's). */
export const availableConnectionNamesFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections, connectionStore } = await getLatch();
    const stored = (await connectionStore.list(principal)).map((c) => c.name);
    return Array.from(new Set([...connections.names, ...stored]));
  },
);

/**
 * Enumerate the tools of the given connections for the agent editor: each
 * real tool with whether it's gated by default (so the UI pre-seeds the
 * GET-free / mutating-gated default). Opens the connections live — unauthorized
 * OAuth / unreachable ones contribute nothing.
 */
export const connectionToolsFn = createServerFn({ method: "GET" })
  .validator((names: string[]) => names)
  .handler(async ({ data: names }) => {
    const principal = await getPrincipal();
    if (!principal || names.length === 0) return [];
    const { allConnections } = await getLatch();
    const opened = await allConnections.hostFor(names).open(principal);
    try {
      const approval = (opened.toolApproval ?? {});
      return Object.keys(opened.tools)
        .filter((k) => !k.startsWith("connect_"))
        .map((name) => ({
          name,
          connection: names.find((n) => name.startsWith(`${n}_`)) ?? name.split("_")[0],
          defaultApproval: !!approval[name],
          description:
            (opened.tools[name] as { description?: string } | undefined)?.description ?? undefined,
        }));
    } finally {
      await opened.close();
    }
  });

/** Create or update a UI agent at its scope. */
export const saveAgentFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      title?: string;
      description?: string;
      modelId: string;
      instructions: string;
      connections: string[];
      maxSteps?: number | "unlimited";
      tools?: {
        enabled: string[];
        approval: Record<string, boolean>;
        descriptions?: Record<string, string>;
      };
      exec?: {
        sandbox?: boolean;
        provider?: string;
        defaultTools?: boolean | string[];
        disableTools?: string[];
        codeMode?: { tools?: string[] };
        providerWebTools?: boolean;
        authoredTools?: string[];
        effort?: "minimal" | "low" | "medium" | "high";
      };
      subagents?: string[];
      scope: "user" | "org";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = normalizeAgentName(data.name);
    if (!name) return { ok: false, error: "name required" };
    if (!data.instructions.trim()) return { ok: false, error: "instructions required" };
    const { agentStore, authoredTools } = await getLatch();
    // An org agent can only attach ORG-scoped tools — a personal tool wouldn't
    // resolve for other members. Validate before persisting.
    const attached = data.exec?.authoredTools ?? [];
    if (data.scope === "org" && attached.length) {
      const orgTools = new Set(
        (await authoredTools.listFor(principal)).filter((t) => t.scope === "org").map((t) => t.name),
      );
      const personal = attached.filter((n) => !orgTools.has(n));
      if (personal.length) {
        return {
          ok: false,
          error: `Org agents can only use org-scoped tools. Make these org-scoped first: ${personal.join(", ")}.`,
        };
      }
    }
    // The editor doesn't manage attached evals — carry them over so a save
    // never silently wipes the agent's online-eval rubrics.
    const existing = await agentStore.getRecord(principal, name);
    await agentStore.upsert(principal, {
      name,
      title: data.title?.trim() || undefined,
      description: data.description?.trim() || undefined,
      modelId: data.modelId,
      instructions: data.instructions,
      connections: data.connections,
      maxSteps: data.maxSteps,
      tools: data.tools,
      exec: data.exec,
      subagents: data.subagents,
      attachedEvals: existing?.attachedEvals,
      scope: data.scope,
    });
    return { ok: true };
  });

/** Delete a UI agent at its scope. */
export const deleteAgentFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { agentStore } = await getLatch();
    await agentStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The caller's scheduled agents, for the Schedules page. */
export const listSchedulesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const schedules = await runtime.listSchedules({ principal });
  return schedules.map((s) => ({
    id: s.id,
    agent: s.agent,
    cron: s.cron,
    prompt: s.prompt,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt ?? null,
    enabled: s.enabled,
  }));
});

// ── Observability (Langfuse): feedback scores + the live trace feed ─────────

/**
 * Record 👍/👎 (+ optional comment) on a run's trace as the Langfuse
 * `user-feedback` score. Ownership-checked: the run must belong to the
 * caller's tenant — a forged runId from another org is rejected.
 */
export const submitFeedbackFn = createServerFn({ method: "POST" })
  .validator((data: { runId: string; value: 0 | 1; comment?: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    if (!isLangfuseConfigured()) return { ok: false as const, error: "langfuse not configured" };
    if (data.value !== 0 && data.value !== 1) return { ok: false as const, error: "bad value" };
    const { runtime } = await getLatch();
    // Direct, principal-scoped lookup (no capped scan) — an unowned or unknown
    // runId returns null, so this both authorizes and validates in one O(1) hop.
    const run = await runtime.getRun({ principal, runId: data.runId });
    if (!run) return { ok: false as const, error: "unknown run" };
    await postScore({
      runId: data.runId,
      name: "user-feedback",
      value: data.value,
      comment: data.comment?.slice(0, 2000),
      // NUMERIC (1/0) so Langfuse can average it into a satisfaction rate.
      dataType: "NUMERIC",
    });
    return { ok: true as const };
  });

/** One row of the observability feed (a run's trace + its scores). */
export interface ObservabilityRow {
  runId: string | null;
  traceId: string;
  agent: string | null;
  timestamp: string;
  inputPreview: string;
  outputPreview: string;
  latencySeconds: number | null;
  cost: number | null;
  scores: { name: string; value: number | string | null; comment?: string; dataType?: string }[];
  deepLink: string | null;
}

const preview = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/**
 * The live observability feed: the tenant's recent traces with judge scores
 * and user feedback joined in, plus per-rubric aggregates over the window.
 * Polled by /observability (~5s) — all Langfuse reads stay server-side and
 * owner-filtered (tenants never get Langfuse credentials).
 */
export const listObservabilityFn = createServerFn({ method: "GET" })
  .validator((data: { agent?: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { configured: false as const, rows: [], aggregates: [], feedback: null };
    if (!isLangfuseConfigured()) {
      return { configured: false as const, rows: [], aggregates: [], feedback: null };
    }
    const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
    const traces = await listOwnerTraces({
      ownerTag: ownerTagOf(principal),
      agent: data.agent || undefined,
      limit: 50,
    });
    const rows: ObservabilityRow[] = traces.map((t) => ({
      runId: t.runId ?? null,
      traceId: t.id,
      agent: t.agent ?? null,
      timestamp: t.timestamp,
      inputPreview: preview(t.input),
      outputPreview: preview(t.output),
      latencySeconds: t.latency ?? null,
      cost: t.totalCost ?? null,
      scores: t.scores,
      deepLink: t.htmlPath ? `${base}${t.htmlPath}` : null,
    }));
    // Per-rubric aggregates over the window; user-feedback becomes a 👍 rate.
    const byName = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      for (const s of row.scores) {
        if (typeof s.value !== "number") continue;
        const agg = byName.get(s.name) ?? { sum: 0, count: 0 };
        agg.sum += s.value;
        agg.count += 1;
        byName.set(s.name, agg);
      }
    }
    const fb = byName.get("user-feedback");
    byName.delete("user-feedback");
    return {
      configured: true as const,
      rows,
      aggregates: Array.from(byName, ([name, a]) => ({
        name,
        average: a.sum / a.count,
        count: a.count,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      feedback: fb ? { rate: fb.sum / fb.count, count: fb.count } : null,
    };
  });

// ── Chat evals panel: rubric CRUD, live scores, on-demand re-judge ──────────

/** The chatted agent's rubrics + whether the caller can edit them (owns it). */
export const getAgentEvalsFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return { editable: false as const, evals: [] as AttachedEval[] };
    const { agentStore } = await getLatch();
    // Only the user's own (editable) agents resolve here; built-ins/others → null.
    const rec = await agentStore.getRecord(principal, normalizeAgentName(agent));
    return { editable: !!rec, evals: rec?.attachedEvals ?? [] };
  });

/** Persist the drawer's rubric set to the agent (the explicit "Save to agent"). */
export const saveAgentEvalsFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; evals: AttachedEval[] }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { agentStore, models } = await getLatch();
    const name = normalizeAgentName(data.agent);
    const rec = await agentStore.getRecord(principal, name);
    if (!rec) return { ok: false as const, error: `No editable agent "${name}".` };
    const valid = validateRubrics(data.evals, (id) => models.some((m) => m.id === id));
    if (!valid.ok) return { ok: false as const, error: valid.error };
    await agentStore.upsert(principal, { ...rec, attachedEvals: valid.rubrics });
    return { ok: true as const, evals: valid.rubrics };
  });

/** Local (fast) eval verdicts for the given run ids — the chat badges poll this. */
export const getRunScoresFn = createServerFn({ method: "POST" })
  .validator((runIds: string[]) => runIds)
  .handler(async ({ data: runIds }) => {
    const principal = await getPrincipal();
    if (!principal || runIds.length === 0) return {} as Record<string, AttachedEvalScore[]>;
    const { runScores } = await getLatch();
    const byRun = await runScores.getForRuns(ownerTagOf(principal), runIds);
    const out: Record<string, AttachedEvalScore[]> = {};
    for (const [runId, scores] of byRun) {
      out[runId] = scores.map((s) => ({
        name: s.rubricName,
        value: s.value,
        comment: s.comment,
        scale: s.scale,
        source: s.source,
        aiValue: s.aiValue,
        aiComment: s.aiComment,
      }));
    }
    return out;
  });

export interface AttachedEvalScore {
  name: string;
  value: number;
  comment?: string;
  scale: "binary" | "score";
  source: "live" | "rejudge" | "human";
  /** Present when source="human": the judge's original value/reason. */
  aiValue?: number;
  aiComment?: string;
}

/** Re-judge one already-sent message against the (draft) rubric set — no re-chat. */
export const rejudgeRunFn = createServerFn({ method: "POST" })
  .validator((data: { chatId: string; runId: string; evals: AttachedEval[] }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    try {
      const verdicts = await rejudgeRun({
        principal,
        chatId: data.chatId,
        runId: data.runId,
        rubrics: data.evals,
      });
      return {
        ok: true as const,
        scores: verdicts.map((v) => ({
          name: v.rubric.name,
          value: v.value,
          comment: v.comment,
          scale: v.rubric.scale,
          source: "rejudge" as const,
        })),
      };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "re-judge failed" };
    }
  });

/**
 * Human correction of a judge verdict: the human sets the authoritative value
 * (+ required note). Updates the local store (source "human", preserving the
 * judge's original value/reason) so the badge flips immediately, AND overwrites
 * the score in Langfuse (human value + note, AI original in metadata) so
 * /observability and Langfuse aggregates reflect the corrected truth.
 */
export const correctScoreFn = createServerFn({ method: "POST" })
  .validator(
    (data: { runId: string; rubricName: string; value: number; comment: string }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    if (!data.comment.trim()) return { ok: false as const, error: "a note is required" };
    const { runtime, runScores } = await getLatch();
    // Ownership: the run must be the caller's (direct, principal-scoped).
    const run = await runtime.getRun({ principal, runId: data.runId });
    if (!run) return { ok: false as const, error: "unknown run" };

    const ownerTag = ownerTagOf(principal);
    const existing = await runScores.getOne(ownerTag, data.runId, data.rubricName);
    if (!existing) return { ok: false as const, error: "no score to correct" };
    const value = existing.scale === "binary" ? (data.value >= 0.5 ? 1 : 0) : data.value;
    // Preserve the judge's original verdict (unless already a human correction).
    const aiValue = existing.source === "human" ? existing.aiValue : existing.value;
    const aiComment = existing.source === "human" ? existing.aiComment : existing.comment;

    await runScores.put(ownerTag, {
      runId: data.runId,
      rubricName: data.rubricName,
      value,
      comment: data.comment.trim(),
      scale: existing.scale,
      source: "human",
      aiValue,
      aiComment,
      updatedAt: Date.now(),
    });
    if (isLangfuseConfigured()) {
      await postScore({
        runId: data.runId,
        name: data.rubricName,
        value,
        comment: data.comment.trim(),
        dataType: existing.scale === "binary" ? "BOOLEAN" : "NUMERIC",
        metadata: {
          corrected: true,
          correctedBy: principal.userId ?? principal.orgId,
          ...(aiValue != null ? { aiValue } : {}),
          ...(aiComment ? { aiComment } : {}),
        },
      });
    }
    return {
      ok: true as const,
      score: {
        name: data.rubricName,
        value,
        comment: data.comment.trim(),
        scale: existing.scale,
        source: "human" as const,
        aiValue,
        aiComment,
      },
    };
  });

/** Extract the single fenced ```json block the eval-author is contracted to emit. */
function parseFencedJson<T>(answer: string): T | null {
  const fence = answer.match(/```json\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : answer).trim();
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** Draft a rubric for a described quality via the eval-author subagent. */
export const draftRubricFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; quality: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const quality = data.quality.trim();
    if (!quality) return { ok: false as const, error: "describe the quality to measure" };
    const { runtime } = await getLatch();
    const brief =
      `Agent: ${normalizeAgentName(data.agent)}. Author ONE online-eval rubric that measures this quality: ` +
      `"${quality}". Return the JSON array (a single rubric) per your output contract.`;
    const { answer } = await runtime.runAgent({
      principal,
      agent: "eval-author",
      prompt: brief,
    });
    const parsed = parseFencedJson<AttachedEval[] | { error: string }>(answer);
    if (!parsed) return { ok: false as const, error: "eval-author returned no valid JSON" };
    if (!Array.isArray(parsed)) {
      return { ok: false as const, error: parsed.error ?? "eval-author could not draft a rubric" };
    }
    return { ok: true as const, rubrics: parsed };
  });

// ── Slack channel: per-agent app onboarding ─────────────────────────────────

/**
 * Generate the Slack app manifest for an agent + the "Create from manifest"
 * deep-link. Used by the editor's Slack section for the manual (B) flow; the
 * one-button (C) flow posts the same manifest to `apps.manifest.create`.
 */
export const slackManifestFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { runtime } = await getLatch();
    const info = (await runtime.listAgents(principal)).find((a) => a.name === agent);
    if (!info) return null;
    const manifest = slackManifest({
      displayName: info.title ?? agent,
      description: info.description,
      requestUrl: `${baseUrl()}/api/slack`,
      redirectUrl: `${baseUrl()}/api/slack/oauth`,
    });
    return {
      manifestJson: JSON.stringify(manifest, null, 2),
      createUrl: createFromManifestUrl(manifest),
    };
  });

/**
 * Bind a (manually created) Slack app by its STATIC credentials — client id +
 * secret + signing secret, all on the app's Basic Information page right after
 * you create it from the manifest (no install needed). We stash them in the
 * Vault, pre-bind the app→agent+owner, and return the "Add to Slack" install
 * URL. The OAuth callback then captures the bot token automatically — so no bot
 * token is ever pasted by hand.
 */
export const installSlackAppFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      appId: string;
      agent: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials } = await getLatch();

    const keys = slackVaultKeys(data.appId);
    await credentials.set(principal, keys.clientId, "org", data.clientId);
    await credentials.set(principal, keys.clientSecret, "org", data.clientSecret);
    await credentials.set(principal, keys.signingSecret, "org", data.signingSecret);

    const botName =
      (await runtime.listAgents(principal)).find((a) => a.name === data.agent)?.title ?? data.agent;
    await slackStore.bind({
      appId: data.appId,
      agent: data.agent,
      orgId: principal.orgId,
      userId: principal.userId,
      botName,
    });

    const authorizeUrl =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(data.clientId)}` +
      `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(","))}` +
      `&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}` +
      `&state=${encodeURIComponent(data.appId)}`;
    return { ok: true as const, authorizeUrl };
  });

/** The caller's org's bound Slack apps (for the editor's status view). */
export const listSlackAppsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { slackStore } = await getLatch();
  return slackStore.listForOrg(principal.orgId);
});

/** Unbind a Slack app from its agent (leaves the Slack app itself untouched). */
export const unbindSlackAppFn = createServerFn({ method: "POST" })
  .validator((appId: string) => appId)
  .handler(async ({ data: appId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { slackStore } = await getLatch();
    await slackStore.unbind(appId);
    return { ok: true };
  });

// ── C: one-button create via org App-Configuration token ────────────────────

/** Whether this org has a Slack config token stored (enables one-button create). */
export const slackConfigStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return { configured: false };
  const { credentials } = await getLatch();
  return { configured: await credentials.has(principal, SLACK_CONFIG_TOKEN_KEY, "org") };
});

/** Store the org's Slack App-Configuration token (+ refresh) in the Vault. */
export const setSlackConfigTokenFn = createServerFn({ method: "POST" })
  .validator((data: { token: string; refreshToken: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { credentials } = await getLatch();
    await credentials.set(principal, SLACK_CONFIG_TOKEN_KEY, "org", data.token);
    await credentials.set(principal, SLACK_CONFIG_REFRESH_KEY, "org", data.refreshToken);
    return { ok: true };
  });

/**
 * One-button: create this agent's Slack app from its manifest (config token),
 * stash its secrets in the Vault, pre-bind it, and return the install URL. The
 * browser is then redirected there; the OAuth callback finishes by storing the
 * bot token. No tokens are ever pasted by hand.
 */
export const createSlackAppFn = createServerFn({ method: "POST" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials } = await getLatch();

    const configToken = await credentials.get(principal, SLACK_CONFIG_TOKEN_KEY, "org");
    if (!configToken) return { ok: false as const, error: "no_config_token" };
    const refreshToken =
      (await credentials.get(principal, SLACK_CONFIG_REFRESH_KEY, "org")) ?? undefined;

    const info = (await runtime.listAgents(principal)).find((a) => a.name === agent);
    if (!info) return { ok: false as const, error: "unknown_agent" };
    const displayName = info.title ?? agent;

    const manifest = slackManifest({
      displayName,
      description: info.description,
      requestUrl: `${baseUrl()}/api/slack`,
      redirectUrl: `${baseUrl()}/api/slack/oauth`,
    });

    let created;
    try {
      created = await createAppFromManifest({
        configToken,
        refreshToken,
        manifest,
        onRotate: async (rot) => {
          await credentials.set(principal, SLACK_CONFIG_TOKEN_KEY, "org", rot.token);
          await credentials.set(principal, SLACK_CONFIG_REFRESH_KEY, "org", rot.refreshToken);
        },
      });
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "create_failed" };
    }

    const keys = slackVaultKeys(created.appId);
    await credentials.set(principal, keys.signingSecret, "org", created.signingSecret);
    await credentials.set(principal, keys.clientId, "org", created.clientId);
    await credentials.set(principal, keys.clientSecret, "org", created.clientSecret);
    await slackStore.bind({
      appId: created.appId,
      agent,
      orgId: principal.orgId,
      userId: principal.userId,
      botName: displayName,
    });

    // Send the installer to Slack; we carry the app id back via `state`.
    const sep = created.oauthAuthorizeUrl.includes("?") ? "&" : "?";
    const authorizeUrl = `${created.oauthAuthorizeUrl}${sep}state=${encodeURIComponent(created.appId)}&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}`;
    return { ok: true as const, authorizeUrl };
  });

// ── Authored tools (latch_tools): sandboxed JS/TS programs over input + fetch ──

/** The caller's authored tools — for the Tools page (code + schema editable). */
export const listAuthoredToolsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { authoredTools } = await getLatch();
  const tools = await authoredTools.listFor(principal);
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    code: t.code,
    // JSON string — editable directly + serializer-safe.
    inputSchema: JSON.stringify(t.inputSchema ?? { type: "object" }, null, 2),
    allowedHosts: t.allowedHosts,
    scope: t.scope,
    updatedAt: t.updatedAt,
  }));
});

/** Lightweight names (+ scope) for the agent editor's tool picker. */
export const listAuthoredToolNamesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { authoredTools } = await getLatch();
  const tools = await authoredTools.listFor(principal);
  return tools.map((t) => ({ name: t.name, description: t.description, scope: t.scope }));
});

/** Create or update an authored tool from the UI. Rename / scope-change = move. */
export const saveAuthoredToolFn = createServerFn({ method: "POST" })
  .validator(
    (t: {
      name: string;
      description: string;
      inputSchema?: string;
      code: string;
      allowedHosts?: string[];
      scope?: "user" | "org";
      originalName?: string;
      originalScope?: "user" | "org";
    }) => t,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "not authenticated" };
    const { authoredTools } = await getLatch();
    const name = authoredTools.cleanName(data.name);
    if (!name) return { ok: false as const, error: "invalid name" };
    if (authoredTools.isReserved(name)) {
      return { ok: false as const, error: `"${name}" is a reserved tool name — pick another.` };
    }
    if (!data.code.trim()) return { ok: false as const, error: "code is empty" };
    let inputSchema: unknown = { type: "object" };
    if (data.inputSchema != null && data.inputSchema.trim()) {
      try {
        inputSchema = JSON.parse(data.inputSchema);
      } catch {
        return { ok: false as const, error: "input schema is not valid JSON" };
      }
    }
    const scope = data.scope === "org" ? "org" : "user";
    const original = data.originalName ? authoredTools.cleanName(data.originalName) : undefined;
    const originalScope = data.originalScope === "org" ? "org" : "user";
    const moved = !!original && (original !== name || originalScope !== scope);
    // A rename/scope-change must not silently clobber a different existing tool.
    if (moved && (await authoredTools.getFor(principal, scope, name))) {
      return { ok: false as const, error: `A ${scope} tool named "${name}" already exists.` };
    }
    // Save the new record FIRST, then drop the old one — so a failed save can
    // never lose the original (no transaction across the two writes).
    await authoredTools.saveFor(principal, scope, {
      name,
      description: String(data.description),
      inputSchema,
      // Normalize hosts the same way save_tool does (drop scheme/path).
      allowedHosts: (data.allowedHosts ?? []).map(authoredTools.cleanHost).filter(Boolean),
      code: data.code,
    });
    if (moved && original) await authoredTools.deleteFor(principal, originalScope, original);
    return { ok: true as const, name, scope };
  });

/** Run an authored program once against the caller's allowlist — the Test panel. */
export const testAuthoredToolFn = createServerFn({ method: "POST" })
  .validator((t: { code: string; input?: unknown; allowedHosts?: string[] }) => t)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { status: "error" as const, error: "not authenticated" };
    const { authoredTools } = await getLatch();
    const r = await authoredTools.run({
      code: data.code,
      input: data.input ?? null,
      allowedHosts: data.allowedHosts,
    });
    return r.status === "completed"
      ? { status: "completed" as const, result: JSON.stringify(r.result ?? null, null, 2) }
      : { status: "error" as const, error: r.error };
  });

/** Delete an authored tool by name + scope. */
export const deleteAuthoredToolFn = createServerFn({ method: "POST" })
  .validator((t: { name: string; scope?: "user" | "org" }) => t)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { authoredTools } = await getLatch();
    await authoredTools.deleteFor(principal, data.scope === "org" ? "org" : "user", authoredTools.cleanName(data.name));
    return { ok: true };
  });
