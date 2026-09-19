import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AppMessage } from "@intentface/latch-core";
import {
  slackManifest,
  createFromManifestUrl,
  SLACK_BOT_SCOPES,
  slackApi,
} from "@intentface/latch-channels/slack";
import {
  isLangfuseConfigured,
  listAdministeredTraces,
  postScore,
} from "@intentface/latch-langfuse";
import {
  DEFAULT_MEMORY_SCHEMAS,
  MEMORY_POLICY_FLOOR,
  USER_SCHEMA_PATH,
  extractionLevelsOf,
  levelConfigOf,
  schemaSections,
  scopeRefOf,
} from "@intentface/latch-memory";
import { getPrincipal } from "./session";
import type { Principal } from "./session";
import { isOrgAdmin } from "./auth";
import { getLatch, ownerTagOf } from "./latch";
import { AgentRecordSchema, normalizeAgentRecord } from "@intentface/latch-agent-builder";
import type { AgentRecord, AgentRecordInput } from "@intentface/latch-agent-builder";
import type { AgentScope } from "./agent-store";
import { normalizeAgentName, evalOwnerKeysOf, evalOwnerOfRecord, rubricsOf } from "./agent-store";
import type { AttachedEval } from "./agent-store";
import { resolveRunners, type Runner } from "./observability/runners";
import { validateRubrics } from "./observability/rubrics";
import { runEvalCases } from "./evals/run";
import type { EvalCase, JsonValue } from "./evals/store";
import { EXPLAIN_MODEL_ID, JUDGE_MODEL_ID } from "./evals/judge";
import { judgeModel } from "./evals/judge-model";
import { isGradedScale } from "./evals/evaluate-rubrics";
import { rejudgeRun } from "./observability/judge-run";
import {
  slackVaultKeys,
  SLACK_CONFIG_TOKEN_KEY,
  SLACK_CONFIG_REFRESH_KEY,
} from "./slack-store";
import { buildOauthState } from "./slack-oauth-state";
import { createAppFromManifest, updateAppManifest, authTest } from "./slack-admin";
import { CHANNEL_KINDS, isDmChannelKind } from "./channel-kinds";
import type { DmChannelKind, KindCtx } from "./channel-kinds";
import { baseUrl } from "./base-url";
import type { CredentialScope } from "./credentials";
import { upsertConnection } from "./connection-upsert";
import type { ConnectionInput } from "./connection-upsert";
import { normalizeSecretName } from "./named-secrets";
import { secretDependents, secretKey } from "./connection-store";
import {
  DeliveryError,
  listAgentChannels,
  parseScheduleDelivery,
  resolveDelivery,
  type ScheduleDelivery,
} from "./schedule-delivery";

/**
 * Every owner key a principal may read eval verdicts under — the one definition
 * shared by all three score read paths (chat badges, the observability overlay,
 * and a correction's lookup), so they can't drift apart.
 *
 * `evalOwnerKeysOf` is the boundary that matters: the agents this caller may
 * administer. `ownerTagOf` is appended for rows written before verdicts moved to
 * the agent's key, and for code-registry agents that have no owner. It is
 * redundant TODAY — `ownerTagOf(p)` is always one of `evalOwnerKeysOf(p)` for
 * every principal shape — but the two derivations live in different modules with
 * nothing enforcing that, so this keeps a future divergence from silently hiding
 * scores. Duplicate keys in the IN-list are harmless.
 */
const scoreReadKeys = (p: Principal): string[] => [
  ...evalOwnerKeysOf(p),
  ownerTagOf(p),
];

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
    .map((c) => ({
      id: c.id,
      title: c.title ?? null,
      agent: c.agent,
      // Derived by the adapter from the chat's latest run — free here, and the
      // sidebar's only signal that a turn is parked waiting on the user.
      lastRunStatus: c.lastRunStatus ?? null,
    }));
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

/**
 * Per-agent prompt-cache stats + lint suggestions for /caching. Scoped to the
 * caller's own runs (the same boundary as /runs); agent configs feed the
 * config-dependent lint rules (R1/R6/R8).
 */
export const cachingStatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return { agents: [], windowDays: 7 };
  const { cachingStats, ownerKeyFor, agentStore } = await getLatch();
  const records = await agentStore.listRecords(principal);
  const agents = await cachingStats.statsFor({
    ownerKey: ownerKeyFor(principal),
    windowDays: 7,
    agents: records.map((r) => ({
      name: r.name,
      modelId: r.modelId,
      instructions: r.instructions,
      memoryEnabled: !!r.exec?.memory,
    })),
  });
  return { agents, windowDays: 7 };
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

/** UI-added connections visible to the caller (org-shared + personal). */
export const listConnectionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { connectionStore, dynamic } = await getLatch();
  const conns = await connectionStore.list(principal);
  // OAuth status for MCP connections (whether the caller has authorized).
  const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
  // Never return tokens or client secrets to the client — just shape + whether
  // auth is set. This explicit projection is the ONLY egress for stored
  // connections; keep it field-by-field (no spreading of the raw blob).
  return conns.map((c) => ({
    name: c.name,
    kind: c.kind,
    scope: c.scope,
    target: c.mcp?.url ?? c.openapi?.spec ?? "",
    hasAuth: c.auth?.kind === "bearer" || c.auth?.kind === "header",
    oauth: c.auth?.kind === "oauth" || c.auth?.kind === "oauth2",
    authorized: status.get(c.name)?.authorized ?? true,
  }));
});

/**
 * One connection's editable config, for prefilling the edit form. Secrets
 * (static token, oauth2 client secret) stay server-side — the form signals
 * their presence via the `has*` flags and keeps them unless a replacement is
 * typed (see the carry-over in `addConnectionFn`).
 */
export const getConnectionFn = createServerFn({ method: "GET" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { connectionStore } = await getLatch();
    // Scope-exact lookup — `get()`'s personal-wins precedence would return the
    // wrong record when a personal connection shadows an org one.
    const conns = await connectionStore.list(principal);
    const c = conns.find((x) => x.name === data.name && x.scope === data.scope);
    if (!c) return null;
    const auth = c.auth;
    return {
      name: c.name,
      kind: c.kind,
      scope: c.scope,
      url: c.mcp?.url,
      spec: c.openapi?.spec,
      baseUrl: c.openapi?.baseUrl,
      operations: c.openapi?.operations?.join(", "),
      authMode:
        auth?.kind === "oauth"
          ? ("oauth" as const)
          : auth?.kind === "oauth2"
            ? ("oauth2" as const)
            : auth
              ? ("token" as const)
              : ("none" as const),
      authHeader: auth?.kind === "header" ? auth.header : undefined,
      hasToken: auth?.kind === "bearer" || auth?.kind === "header",
      authorizeUrl: auth?.kind === "oauth2" ? auth.authorizeUrl : undefined,
      tokenUrl: auth?.kind === "oauth2" ? auth.tokenUrl : undefined,
      clientId: auth?.kind === "oauth2" ? auth.clientId : undefined,
      hasClientSecret: auth?.kind === "oauth2",
      scopes:
        auth?.kind === "oauth2" || auth?.kind === "oauth"
          ? auth.scopes?.join(" ")
          : undefined,
    };
  });

/**
 * Add a UI-defined connection (stored encrypted in the Vault at its scope).
 * The rules live in `upsertConnection` so this and the Agent Builder's
 * `create_connection` validate identically.
 */
export const addConnectionFn = createServerFn({ method: "POST" })
  .validator((data: ConnectionInput) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    // Org-shared connections are called by every member's agents — only
    // owners/admins may create, overwrite or repoint them.
    if (data.scope === "org" && !(await isOrgAdmin(principal.userId!, principal.orgId))) {
      return { ok: false, error: "only org admins can manage org-shared connections" };
    }
    const { connectionStore, dynamic, namedSecrets } = await getLatch();
    const result = await upsertConnection(principal, data, {
      connectionStore,
      dynamic,
      namedSecrets,
    });
    if (result.ok) {
      console.log(
        `[connections] upsert name=${result.name} scope=${data.scope} kind=${data.kind} by=${principal.userId ?? "-"}@${principal.orgId}`,
      );
    }
    return result;
  });

/** Remove a UI-defined connection at its scope. */
export const removeConnectionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    // Same gate as addConnectionFn: org-shared connections are admin-managed.
    if (data.scope === "org" && !(await isOrgAdmin(principal.userId!, principal.orgId))) {
      return { ok: false };
    }
    const { connectionStore } = await getLatch();
    await connectionStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The agents available to the caller (code + UI-created), for the picker. */
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  // `memory-*` are system agents spawned only by the memory sweep — hide them
  // from the user-facing picker (they stay runnable by name for the sweep).
  return (await runtime.listAgents(principal)).filter((a) => !a.name.startsWith("memory-"));
});

// ---------------------------------------------------------------------------
// Named secrets
//
// The ONLY path a credential's plaintext takes. The Agent Builder asks for a
// secret by NAME (`request_secret`); the composer collects the value and posts
// it here; the agent's tool result carries names only. Nothing on this path
// writes a value into a message part, a tool input, or a tool output — see
// `lib/named-secrets.ts`.
// ---------------------------------------------------------------------------

/**
 * Names + scopes of the caller's stored secrets, each with the connections that
 * depend on it. Never values.
 *
 * `usedBy` is the whole reason connections store a reference: it says, at rest,
 * what Replace will rotate and what Delete will break.
 */
export const listSecretsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { namedSecrets, connectionStore } = await getLatch();
  const [secrets, conns] = await Promise.all([
    namedSecrets.list(principal),
    connectionStore.list(principal),
  ]);
  const dependents = secretDependents(conns);
  return secrets.map((s) => ({
    ...s,
    usedBy: dependents.get(secretKey(s.scope, s.name)) ?? [],
  }));
});

/**
 * The wire contract for a secret batch. `.validator()` in this file is types
 * only, and these endpoints are callable directly — so the shape is parsed for
 * real here. `scope` especially: every reader compares it with `=== "org"`, so
 * an unrecognised value would quietly mean "user". The 6-entry cap mirrors
 * `request_secret`'s `fields` cap (one form, one batch) and bounds Vault writes.
 */
const SAVE_SECRETS_INPUT = z.object({
  scope: z.enum(["user", "org"]),
  secrets: z
    .array(z.object({ name: z.string(), value: z.string().min(1) }))
    .min(1)
    .max(6),
});

const DELETE_SECRET_INPUT = z.object({
  name: z.string(),
  scope: z.enum(["user", "org"]),
});

const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? "invalid request";

/**
 * Store one or more secret values under caller-chosen names. Returns the names
 * only, which is what the paused `request_secret` tool result is built from.
 */
export const saveSecretsFn = createServerFn({ method: "POST" })
  .validator(
    (data: { scope: CredentialScope; secrets: { name: string; value: string }[] }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const parsed = SAVE_SECRETS_INPUT.safeParse(data);
    if (!parsed.success) return { ok: false as const, error: firstIssue(parsed.error) };
    const { scope, secrets } = parsed.data;
    // Org-shared secrets back connections every member's agents call — same
    // gate as the connections they feed.
    if (scope === "org" && !(await isOrgAdmin(principal.userId!, principal.orgId))) {
      return { ok: false as const, error: "only org admins can store org-shared secrets" };
    }
    // Normalize the WHOLE batch before the first write: a bad name halfway
    // through would otherwise leave some secrets stored and some not, with the
    // caller told only that it failed.
    const entries: { name: string; value: string }[] = [];
    for (const s of secrets) {
      const name = normalizeSecretName(s.name);
      if (!name) return { ok: false as const, error: "secret name required" };
      entries.push({ name, value: s.value });
    }
    const { namedSecrets } = await getLatch();
    const saved: string[] = [];
    for (const e of entries) {
      await namedSecrets.set(principal, e.name, scope, e.value);
      saved.push(e.name);
    }
    // Audit: names and actor only — never the value.
    console.log(
      `[secrets] saved ${saved.join(",")} scope=${parsed.data.scope} by=${principal.userId ?? "-"}@${principal.orgId}`,
    );
    return { ok: true as const, saved };
  });

/**
 * Delete a stored secret at its scope. This REVOKES every connection that
 * references it — they stop contributing tools rather than calling out
 * unauthenticated. The UI names those connections before asking to confirm; the
 * audit line records them.
 */
export const deleteSecretFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: CredentialScope }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const parsed = DELETE_SECRET_INPUT.safeParse(data);
    if (!parsed.success) return { ok: false as const, error: firstIssue(parsed.error) };
    const { scope } = parsed.data;
    if (scope === "org" && !(await isOrgAdmin(principal.userId!, principal.orgId))) {
      return { ok: false as const, error: "only org admins can delete org-shared secrets" };
    }
    // Normalize exactly as `saveSecretsFn` does: secrets are STORED under the
    // normalized name, so deleting the raw one would remove nothing while the
    // audit line below claimed otherwise.
    const name = normalizeSecretName(parsed.data.name);
    if (!name) return { ok: false as const, error: "secret name required" };
    const { namedSecrets, connectionStore } = await getLatch();
    const revoked =
      secretDependents(await connectionStore.list(principal)).get(secretKey(scope, name)) ?? [];
    await namedSecrets.remove(principal, name, scope);
    console.log(
      `[secrets] deleted ${name} scope=${scope} by=${principal.userId ?? "-"}@${principal.orgId} revoked=${revoked.join(",") || "-"}`,
    );
    return { ok: true as const, revoked };
  });

/** The model catalog (id + label) for the agent editor's dropdown (from models.dev). */
export const listModelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { models } = await getLatch();
  return models;
});

/**
 * Full UI-created agent records (org + personal), for the editor. Attached
 * evals are stripped: the editor doesn't manage them (saveAgentFn carries them
 * over), and their host-defined `trigger` is opaque to the wire type.
 */
export const listAgentRecordsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { agentStore } = await getLatch();
  return (await agentStore.listRecords(principal)).map(({ attachedEvals: _evals, ...rec }) => rec);
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

/**
 * Create or update a UI agent at its scope. The record schema owns the shape
 * and the host-independent invariants (memory connection wired, org-shared
 * memory needs an org agent, index schemas are outlines); what stays here is
 * platform policy — the reserved `memory-*` prefix and the org-tools rule.
 */
/** What the editor sends when publishing: the record, plus publish metadata. */
export interface SaveAgentInput {
  record: AgentRecordInput;
  /** Optional one-line note for the history row. */
  message?: string;
  /**
   * The version the editor started from. When it no longer matches what is live,
   * someone else published in the meantime and this save would silently revert
   * them — so it is refused unless `force` is set. Omitted when creating.
   */
  baseVersion?: number;
  /** Publish anyway, after the user has seen what changed. */
  force?: boolean;
}

/** Refused because someone else published while this editor was away. */
export interface StalePublish {
  ok: false;
  stale: true;
  /** What is live now. */
  liveVersion: number;
  /** What this editor's draft was based on. */
  baseVersion: number;
  author?: string;
  at?: number;
}

/** A one-line cap on the history note, so a stray paste can't fill the column. */
const MESSAGE_MAX = 500;

export const saveAgentFn = createServerFn({ method: "POST" })
  .validator((data: SaveAgentInput) => data)
  .handler(async ({ data: input }) => {
    const data = input.record;
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const parsed = AgentRecordSchema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        error: first ? `${first.path.join(".") || "agent"}: ${first.message}` : "invalid agent",
      };
    }
    const rec = normalizeAgentRecord(parsed.data);
    // `memory-*` is reserved for the platform's memory system agents —
    // listAgentsFn hides the whole prefix, so a user agent named this way
    // would save fine and then vanish from every picker.
    if (rec.name.startsWith("memory-")) {
      return { ok: false, error: `"${rec.name}" is reserved (memory-* are platform system agents).` };
    }
    const { agentStore, authoredTools, models } = await getLatch();
    // The record schema keeps a rubric's `trigger` opaque; if the caller
    // supplies rubrics, run the platform's real validation (trigger AST, judge
    // model in the catalog) — the same gate attach_evals and the drawer use.
    if (rec.attachedEvals) {
      const valid = validateRubrics(rubricsOf(rec), (id) => models.some((m) => m.id === id));
      if (!valid.ok) return { ok: false, error: valid.error };
      rec.attachedEvals = valid.rubrics;
    }
    // An org agent can only attach ORG-scoped tools — a personal tool wouldn't
    // resolve for other members. Validate before persisting.
    const attached = rec.exec?.authoredTools ?? [];
    if (rec.scope === "org" && attached.length) {
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
    // never silently wipes the agent's online-eval rubrics. Pinned to the
    // record's scope: a same-named agent in the other scope must not donate.
    const existing = await agentStore.getRecord(principal, `${rec.scope}:${rec.name}`);

    // Someone else published while this editor was away? Publishing blind would
    // silently revert them. Refuse once, with enough detail for the UI to show
    // what changed, and let the user decide.
    if (existing && input.baseVersion != null && !input.force) {
      const live = (await agentStore.listVersions(principal, rec.name, rec.scope)).find(
        (v) => v.published,
      );
      if (live && live.version !== input.baseVersion) {
        return {
          ok: false,
          stale: true,
          liveVersion: live.version,
          baseVersion: input.baseVersion,
          author: live.author,
          at: live.createdAt,
        } satisfies StalePublish;
      }
    }

    await agentStore.upsert(
      principal,
      { ...rec, attachedEvals: rec.attachedEvals ?? existing?.attachedEvals },
      {
        source: "editor",
        author: principal.userId,
        message: input.message?.slice(0, MESSAGE_MAX),
      },
    );
    // Published — the working copy has served its purpose.
    await agentStore.discardDraft(principal, rec.name, rec.scope);
    return { ok: true };
  });

/**
 * The caller's unpublished working copy, plus what it needs to be shown safely:
 * which version is live, and whether a colleague is mid-edit on the same agent.
 */
export const getAgentDraftFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: AgentScope }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { agentStore } = await getLatch();
    const name = normalizeAgentName(data.name);
    const [draft, versions, drafts] = await Promise.all([
      agentStore.getDraft(principal, name, data.scope),
      agentStore.listVersions(principal, name, data.scope),
      agentStore.listDrafts(principal),
    ]);
    const live = versions.find((v) => v.published);
    // Attached evals are stripped on the way out for the same reason
    // `listAgentRecordsFn` strips them: the editor doesn't manage them, and
    // their host-defined `trigger` is opaque to the wire type.
    const draftRecord = draft ? { ...draft.record, attachedEvals: undefined } : null;
    return {
      draft: draftRecord ? { record: draftRecord, baseVersion: draft!.baseVersion } : null,
      liveVersion: live?.version ?? null,
      // Colleagues mid-edit on this same agent. Existence only — their
      // in-progress text is not this caller's to read.
      othersEditing: drafts.filter(
        (d) => d.name === name && d.scope === data.scope && !d.mine,
      ).length,
    };
  });

/** Autosave. Never touches the live record. */
export const saveAgentDraftFn = createServerFn({ method: "POST" })
  .validator((data: { record: AgentRecordInput; baseVersion?: number }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    // A draft is work in progress, so it is NOT held to the full record schema —
    // half-written is the normal state. Only the identity it is filed under has
    // to be sound, and publishing validates properly.
    const rec = data.record as AgentRecord;
    const name = normalizeAgentName(rec?.name ?? "");
    if (!name || (rec.scope !== "org" && rec.scope !== "user")) {
      return { ok: false as const, error: "invalid draft" };
    }
    const { agentStore } = await getLatch();
    await agentStore.saveDraft(principal, name, rec.scope, rec, data.baseVersion);
    return { ok: true as const };
  });

/** Throw the working copy away and fall back to what is published. */
export const discardAgentDraftFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: AgentScope }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const };
    const { agentStore } = await getLatch();
    await agentStore.discardDraft(principal, normalizeAgentName(data.name), data.scope);
    return { ok: true as const };
  });

/** Agents the caller has an unpublished draft on — the list page's badge. */
export const listAgentDraftsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { agentStore } = await getLatch();
  return (await agentStore.listDrafts(principal)).filter((d) => d.mine);
});

/** Publish history for one agent, newest first. */
export const listAgentVersionsFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: AgentScope }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { agentStore } = await getLatch();
    return agentStore.listVersions(principal, normalizeAgentName(data.name), data.scope);
  });

/** One version's full record — for preview, diff, or restoring into a draft. */
export const getAgentVersionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: AgentScope; version: number }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { agentStore } = await getLatch();
    const rec = await agentStore.getVersion(
      principal,
      normalizeAgentName(data.name),
      data.scope,
      data.version,
    );
    if (!rec) return null;
    // Same as listAgentRecordsFn: attached evals aren't editor-managed and
    // their host-defined `trigger` is opaque to the wire type.
    const { attachedEvals: _evals, ...wire } = rec;
    return wire;
  });

/**
 * Make an existing version live again — rollback. Moves the pointer; appends no
 * version, so flipping between two configurations never inflates history.
 */
export const activateAgentVersionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: AgentScope; version: number }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { agentStore } = await getLatch();
    try {
      await agentStore.activateVersion(
        principal,
        normalizeAgentName(data.name),
        data.scope,
        data.version,
        { actor: principal.userId },
      );
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });

/**
 * Memory status for one agent under the CALLER's scope resolution (the agent
 * editor's Memory panel). Per-user scopes show the caller's own store — other
 * users' stores are theirs.
 */
export const getMemoryStatusFn = createServerFn({ method: "GET" })
  .validator((data: { name: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { agentStore, memoryJobs } = await getLatch();
    const rec = await agentStore.getRecord(principal, normalizeAgentName(data.name));
    const memory = rec?.exec?.memory;
    if (!rec || !memory) return { enabled: false as const };
    // One status row per participating level (primary first) — a level whose
    // scope can't resolve for THIS caller (e.g. no userId) reports that
    // instead of vanishing.
    const levels = await Promise.all(
      extractionLevelsOf(memory).map(async (level) => {
        const scope = scopeRefOf({
          agent: rec.name,
          memory: levelConfigOf(memory, level),
          userId: principal.userId,
        });
        if (!scope) return { level, resolvable: false as const };
        const state = await memoryJobs.scopeState(scope.key);
        const usage = await memoryJobs.usageFor(scope.key);
        return {
          level,
          resolvable: true as const,
          root: scope.root,
          pendingEpisodes: state?.pendingEpisodes.length ?? 0,
          lastConsolidatedAt: state?.lastConsolidatedAt ?? null,
          failures: state?.failures ?? 0,
          trackedMemories: usage.length,
        };
      }),
    );
    return {
      enabled: true as const,
      scope: memory.scope,
      connection: memory.connection,
      levels,
      // The Loredex web app isn't derivable from the MCP URL — deep-link only
      // when the deployment configures it.
      loredexUrl: process.env.LOREDEX_APP_URL || null,
    };
  });

/**
 * Connections the caller's memory-enabled agents actually store memories in —
 * UI agents' `exec.memory.connection` plus the code-agent registry. Drives
 * which connections get a "User memory schema" editor on the Connections page
 * (the shared `USER_SCHEMA_PATH` file lives once per workspace, so it's
 * edited per memory connection, not per agent).
 */
export const listMemoryConnectionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [] as string[];
  const { agentStore } = await getLatch();
  const { memoryEnabledCodeAgents } = await import("@/agents/memory-enabled");
  const records = await agentStore.listRecords(principal);
  const names = new Set<string>();
  for (const rec of records) {
    const conn = rec.exec?.memory?.connection;
    if (conn) names.add(conn);
  }
  for (const cfg of Object.values(memoryEnabledCodeAgents)) names.add(cfg.connection);
  return [...names].sort();
});

/**
 * Draft the SHARED user-level schema for one memory connection from the
 * system prompts of every agent that stores memories there (code agents
 * contribute name + description — their instructions are factory-built).
 */
export const generateUserMemorySchemaFn = createServerFn({ method: "POST" })
  .validator((data: { connection: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    try {
      const { agentStore } = await getLatch();
      const { memoryEnabledCodeAgents } = await import("@/agents/memory-enabled");
      const { agents: codeAgents } = await import("@/agents");
      const contributors: Array<{ name: string; instructions?: string; description?: string }> =
        [];
      for (const rec of await agentStore.listRecords(principal)) {
        if (rec.exec?.memory?.connection === data.connection) {
          contributors.push({ name: rec.name, instructions: rec.instructions });
        }
      }
      for (const [name, cfg] of Object.entries(memoryEnabledCodeAgents)) {
        if (cfg.connection === data.connection) {
          const meta = (codeAgents as Record<string, { meta?: { description?: string } }>)[name]
            ?.meta;
          contributors.push({ name, description: meta?.description });
        }
      }
      if (contributors.length === 0) {
        return { ok: false as const, error: "no memory-enabled agents use this connection" };
      }
      const { buildSharedUserSchemaPrompt } = await import("./memory/schema-generation");
      const { generateText } = await import("ai");
      const { anthropic } = await import("@ai-sdk/anthropic");
      const { text } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        ...buildSharedUserSchemaPrompt({ connection: data.connection, agents: contributors }),
      });
      const schema = extractSchemaMarkdown(text);
      if (!schema || schemaSections(schema).length === 0) {
        return { ok: false as const, error: "the model returned no usable outline — try again" };
      }
      return { ok: true as const, schema, agents: contributors.map((c) => c.name) };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });

/**
 * Draft a memory index schema for one level from the agent's purpose — one
 * model call, shared by the editor's "Generate" button (the builder agent has
 * its own tool wrapping the same prompt).
 */
export const generateMemorySchemaFn = createServerFn({ method: "POST" })
  .validator(
    (data: { name: string; instructions: string; level: "agent-user" | "agent-org" | "user" }) =>
      data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    if (!data.instructions.trim()) {
      return { ok: false as const, error: "agent instructions required" };
    }
    try {
      const { buildSchemaGenerationPrompt } = await import("./memory/schema-generation");
      const { generateText } = await import("ai");
      const { anthropic } = await import("@ai-sdk/anthropic");
      const { text } = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        ...buildSchemaGenerationPrompt({
          agent: data.name,
          instructions: data.instructions,
          level: data.level,
        }),
      });
      const schema = extractSchemaMarkdown(text);
      if (!schema || schemaSections(schema).length === 0) {
        return { ok: false as const, error: "the model returned no usable outline — try again" };
      }
      return { ok: true as const, schema };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });

/** The generated outline, whether fenced or bare. */
function extractSchemaMarkdown(text: string): string {
  const fenced = /```(?:markdown|md)?\n([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * The org-wide `user`-level schema file (shared workspace path — see
 * USER_SCHEMA_PATH). Read/written under the caller's principal; the policy
 * floor rides along for the editor to display read-only.
 */
export const getUserMemorySchemaFn = createServerFn({ method: "GET" })
  .validator((data: { connection: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { memoryStore } = await getLatch();
    const schema = await memoryStore.readFile(principal, {
      connection: data.connection,
      path: USER_SCHEMA_PATH,
    });
    return {
      schema: schema ?? null,
      defaultSchema: DEFAULT_MEMORY_SCHEMAS.user,
      policy: MEMORY_POLICY_FLOOR.user,
      path: USER_SCHEMA_PATH,
    };
  });

export const saveUserMemorySchemaFn = createServerFn({ method: "POST" })
  .validator((data: { connection: string; schema: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    // One workspace file steers every member's cross-agent profile extraction
    // — org-wide policy, so admin-gated like org connections/secrets.
    if (!(await isOrgAdmin(principal.userId!, principal.orgId))) {
      return { ok: false as const, error: "only an org admin can edit the shared user schema" };
    }
    if (data.schema.length > 4000) {
      return { ok: false as const, error: "schema too long (max 4000 chars)" };
    }
    if (schemaSections(data.schema).length === 0) {
      return {
        ok: false as const,
        error: 'the schema needs at least one "## Section" heading — it is the index outline',
      };
    }
    const { memoryStore } = await getLatch();
    try {
      await memoryStore.writeFile(principal, {
        connection: data.connection,
        path: USER_SCHEMA_PATH,
        content: data.schema.endsWith("\n") ? data.schema : `${data.schema}\n`,
        summary: "Shared user-memory index schema (all agents, user level)",
      });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
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

/** What the Schedules page knows about one schedule. */
export interface ScheduleSummary {
  id: string;
  agent: string;
  cron: string | null;
  timezone: string | null;
  prompt: string;
  nextRunAt: number;
  lastRunAt: number | null;
  /** The newest fired conversation — "Open latest run". */
  lastChatId: string | null;
  enabled: boolean;
  onParked: "skip" | "fire";
  /** Full target (IDs only, no secrets) so the edit dialog can preselect it. */
  delivery: ScheduleDelivery | null;
  /** The last fire's chat stopped awaiting a human (approval / question). */
  parked: boolean;
}

/** The caller's scheduled agents, for the Schedules page. */
export const listSchedulesFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ScheduleSummary[]> => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { runtime } = await getLatch();
    const [schedules, chats] = await Promise.all([
      runtime.listSchedules({ principal }),
      // lastRunStatus only comes from listChats (getChat never derives it), so
      // widen the window well past the schedule count. A lastChatId older than
      // the newest 1000 chats reports parked=false — accepted residual.
      runtime.listChats({ principal, limit: 1000 }),
    ]);
    // "waiting on you" is chat state, not schedule state: the fired chat's
    // last run stopped on an approval or a question nobody has answered.
    const statusOf = new Map(chats.map((c) => [c.id, c.lastRunStatus ?? null]));
    return schedules.map((s) => {
      const delivery = parseScheduleDelivery(s.delivery);
      const lastChatId = s.lastChatId ?? null;
      return {
        id: s.id,
        agent: s.agent,
        cron: s.cron,
        timezone: s.timezone ?? null,
        prompt: s.prompt,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt ?? null,
        lastChatId,
        enabled: s.enabled,
        onParked: s.onParked ?? "skip",
        delivery: delivery ?? null,
        parked: lastChatId ? statusOf.get(lastChatId) === "awaiting_input" : false,
      };
    });
  },
);

/** The delivery targets the caller may point a schedule for `agent` at. */
export const listAgentChannelsFn = createServerFn({ method: "GET" })
  .validator((data: { agent: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    return listAgentChannels(principal, data.agent);
  });

/**
 * Create a schedule, validating any delivery target first.
 *
 * The Schedules page posts here rather than to the generic `POST /schedules`
 * REST route: delivery entitlement is a platform concept (bots, identity links,
 * org membership) that `@intentface/latch-server` deliberately knows nothing
 * about, so that route stays delivery-free rather than accepting a target it
 * couldn't check.
 */
export const createScheduleFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      agent: string;
      cron: string | null;
      timezone?: string;
      prompt: string;
      delivery?: unknown;
      onParked?: "skip" | "fire";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    let delivery: ScheduleDelivery | undefined;
    if (data.delivery) {
      const parsed = parseScheduleDelivery(data.delivery);
      if (!parsed) return { ok: false as const, error: "Unrecognized delivery target." };
      try {
        await resolveDelivery(principal, data.agent, parsed);
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof DeliveryError ? e.message : "Delivery target rejected.",
        };
      }
      delivery = parsed;
    }
    const { runtime } = await getLatch();
    try {
      await runtime.schedule({
        principal,
        agent: data.agent,
        cron: data.cron,
        timezone: data.timezone,
        prompt: data.prompt,
        delivery,
        onParked: data.onParked,
      });
      return { ok: true as const };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Failed to create schedule",
      };
    }
  });

/**
 * Save changes to a schedule. The runtime has no in-place update, so this is
 * create-new-then-unschedule-old: the id changes and the fired-chat pointer
 * resets. Create runs first — a failure between the two steps leaves a
 * duplicate to delete, never a silently missing schedule.
 */
export const updateScheduleFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      id: string;
      agent: string;
      cron: string | null;
      timezone?: string;
      prompt: string;
      delivery?: unknown;
      onParked?: "skip" | "fire";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    let delivery: ScheduleDelivery | undefined;
    if (data.delivery) {
      const parsed = parseScheduleDelivery(data.delivery);
      if (!parsed) return { ok: false as const, error: "Unrecognized delivery target." };
      try {
        await resolveDelivery(principal, data.agent, parsed);
      } catch (e) {
        return {
          ok: false as const,
          error: e instanceof DeliveryError ? e.message : "Delivery target rejected.",
        };
      }
      delivery = parsed;
    }
    const { runtime } = await getLatch();
    let replacement;
    try {
      replacement = await runtime.schedule({
        principal,
        agent: data.agent,
        cron: data.cron,
        timezone: data.timezone,
        prompt: data.prompt,
        delivery,
        onParked: data.onParked,
      });
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Failed to save schedule",
      };
    }
    try {
      await runtime.unschedule({ principal, id: data.id });
      return { ok: true as const };
    } catch {
      // The replacement exists but the old schedule survived. Roll the
      // replacement back so a retry can't stack duplicates; if even that
      // fails, say exactly what state the user is in.
      try {
        await runtime.unschedule({ principal, id: replacement.id });
        return {
          ok: false as const,
          error: "Couldn't replace the schedule — nothing was changed. Try again.",
        };
      } catch {
        return {
          ok: false as const,
          error:
            "The updated schedule was created but the old one couldn't be removed — delete the duplicate by hand.",
        };
      }
    }
  });

/**
 * Make one of the caller's schedules due immediately. It then fires on the next
 * cron tick through the ordinary path — same claim, same delivery, same
 * advance — so "run now" can't drift from what the schedule actually does.
 */
export const runScheduleNowFn = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime } = await getLatch();
    // Owner-fenced and enabled-only, so a stale id from a page loaded before
    // the schedule fired arms nothing — report that rather than "queued".
    const armed = await runtime.runScheduleNow({ principal, id: data.id });
    return armed
      ? { ok: true as const }
      : { ok: false as const, error: "That schedule is no longer active." };
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
    // Best-effort: a thumbs signal is non-critical, so a slow/down Langfuse
    // shouldn't fail the click. postScore is already bounded + retry-free.
    try {
      await postScore({
        runId: data.runId,
        name: "user-feedback",
        value: data.value,
        comment: data.comment?.slice(0, 2000),
        // NUMERIC (1/0) so Langfuse can average it into a satisfaction rate.
        dataType: "NUMERIC",
        // Pin to the run's start so flipping 👍↔👎 later upserts one score.
        timestamp: run.startedAt,
      });
    } catch (e) {
      console.warn(`feedback postScore failed (run ${data.runId}):`, e);
      return { ok: false as const, error: "feedback could not be saved" };
    }
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
  /** Who ran the turn — absent when the trace carries no user id. */
  runner: Runner | null;
}

const preview = (v: unknown): string => {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/**
 * The live observability feed: recent traces of the agents the caller
 * ADMINISTERS — including runs by other users — plus the caller's own runs, with
 * judge scores and user feedback joined in and per-rubric aggregates over the
 * window. Polled by /observability (~5s); all Langfuse reads stay server-side
 * (tenants never get Langfuse credentials).
 *
 * Tenancy: the owner keys passed to `listAdministeredTraces` are derived from the
 * session principal alone, never from `data`. `agent` only narrows.
 */
export const listObservabilityFn = createServerFn({ method: "GET" })
  .validator((data: { agent?: string; runner?: string; anonymous?: boolean }) => data)
  .handler(async ({ data }) => {
    const empty = {
      configured: false as const,
      rows: [],
      aggregates: [],
      feedback: null,
      runners: [],
    };
    const principal = await getPrincipal();
    if (!principal) return empty;
    if (!isLangfuseConfigured()) return empty;
    const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
    const selfTag = ownerTagOf(principal);
    // The agents this caller may administer — and therefore whose eval verdicts
    // are theirs to read, whoever produced them.
    const evalOwners = evalOwnerKeysOf(principal);
    const traces = await listAdministeredTraces({
      agentOwnerTags: evalOwners,
      ownerTag: selfTag,
      agent: data.agent || undefined,
      limit: 50,
    });

    const { runScores, resolveUsers } = await getLatch();
    const runners = await resolveRunners({
      tags: traces.map((t) => t.userId ?? "").filter((t) => t.length > 0),
      selfTag,
      anonymous: data.anonymous === true,
      lookup: resolveUsers,
    });

    let rows: ObservabilityRow[] = traces.map((t) => ({
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
      runner: (t.userId ? runners.get(t.userId) : undefined) ?? null,
    }));

    // The full runner list is built BEFORE filtering, so narrowing to one person
    // doesn't collapse the dropdown to just them.
    const runnerOptions = [...new Map([...runners.values()].map((r) => [r.key, r])).values()].sort(
      (a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.label.localeCompare(b.label)),
    );
    // Narrows WITHIN the window rather than fetching that person's own newest 50 —
    // this feed has always been "the recent N", and both the runner list and the
    // aggregates are scoped to the same window, so they stay consistent with the
    // rows on screen. A quiet colleague can therefore drop out of the window
    // entirely; per-runner history belongs in Langfuse (deep-linked per row).
    if (data.runner) rows = rows.filter((r) => r.runner?.key === data.runner);

    // Overlay local human corrections onto the Langfuse-derived scores. Langfuse
    // is the record of truth but has read-side ingestion lag (~20–45s), and a
    // correction of a rubric that the live judge already scored can briefly show
    // as two same-named scores until ingestion settles. The local store holds the
    // authoritative human verdict immediately, so we replace by (runId, name):
    // this both dedups and reflects corrections without waiting on Langfuse.
    const runIds = rows.map((r) => r.runId).filter((id): id is string => !!id);
    if (runIds.length > 0) {
      const localByRun = await runScores.getForRuns(scoreReadKeys(principal), runIds);
      for (const row of rows) {
        if (!row.runId) continue;
        const corrections = localByRun.get(row.runId)?.filter((s) => s.source === "human");
        if (!corrections?.length) continue;
        const byName = new Map(row.scores.map((s) => [s.name, s]));
        for (const c of corrections) {
          byName.set(c.rubricName, {
            name: c.rubricName,
            value: c.value,
            comment: c.comment,
            dataType:
              c.scale === "choice" ? "CATEGORICAL" : isGradedScale(c.scale) ? "NUMERIC" : "BOOLEAN",
          });
        }
        row.scores = Array.from(byName.values());
      }
    }
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
      runners: runnerOptions,
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
    return { editable: !!rec, evals: rubricsOf(rec) };
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

/**
 * Local (fast) eval verdicts for the given run ids — the chat badges poll this.
 *
 * Reads under the caller's eval-owner keys, so verdicts are visible only to
 * someone who administers the judged agent. A user who merely RUNS another's
 * agent matches no key and gets nothing back — that's what keeps my rubrics'
 * verdicts off their screen, without a separate permission check.
 */
export const getRunScoresFn = createServerFn({ method: "POST" })
  .validator((runIds: string[]) => runIds)
  .handler(async ({ data: runIds }) => {
    const principal = await getPrincipal();
    if (!principal || runIds.length === 0) return {} as Record<string, AttachedEvalScore[]>;
    const { runScores } = await getLatch();
    const byRun = await runScores.getForRuns(scoreReadKeys(principal), runIds);
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
  scale: "binary" | "boolean" | "score" | "choice";
  /** Choice rubrics: the option selected. */
  choice?: string;
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
    // Client-supplied rubrics: enforce the same limits as the save path
    // (≤7, kebab names, prompt length, known judge model) before judging so a
    // caller can't fan out hundreds of judge calls or pin an arbitrary model.
    const { models } = await getLatch();
    const valid = validateRubrics(data.evals, (id) => models.some((m) => m.id === id));
    if (!valid.ok) return { ok: false as const, error: valid.error };
    try {
      const verdicts = await rejudgeRun({
        principal,
        chatId: data.chatId,
        runId: data.runId,
        rubrics: valid.rubrics,
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
    if (!Number.isFinite(data.value)) return { ok: false as const, error: "value must be a finite number" };
    const { runtime, runScores } = await getLatch();
    // Ownership: the run must be the caller's (direct, principal-scoped).
    const run = await runtime.getRun({ principal, runId: data.runId });
    if (!run) return { ok: false as const, error: "unknown run" };

    const existing = await runScores.getOne(
      scoreReadKeys(principal),
      data.runId,
      data.rubricName,
    );
    if (!existing) return { ok: false as const, error: "no score to correct" };
    // Binary → 1/0; graded → clamp to [0,1]. Never persist an out-of-range or
    // NaN value (it would skew /observability aggregates and poison averages).
    const value = isGradedScale(existing.scale)
      ? Math.max(0, Math.min(1, data.value))
      : data.value >= 0.5
        ? 1
        : 0;
    // Preserve the judge's original verdict (unless already a human correction).
    const aiValue = existing.source === "human" ? existing.aiValue : existing.value;
    const aiComment = existing.source === "human" ? existing.aiComment : existing.comment;

    // Upsert the row we actually matched — writing under a different key would
    // fork a second verdict for the same run+rubric.
    await runScores.put(existing.owner, {
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
      // The correction is already persisted locally (above) and /observability
      // overlays local human corrections, so it's applied regardless — a
      // slow/down Langfuse must not fail the user's save. Best-effort mirror.
      try {
        await postScore({
          runId: data.runId,
          name: data.rubricName,
          value,
          comment: data.comment.trim(),
          dataType:
            existing.scale === "choice"
              ? "CATEGORICAL"
              : isGradedScale(existing.scale)
                ? "NUMERIC"
                : "BOOLEAN",
          // Same timestamp as the original live verdict (the run's start) so this
          // correction overwrites it in Langfuse instead of adding a second score.
          timestamp: run.startedAt,
          metadata: {
            corrected: true,
            correctedBy: principal.userId ?? principal.orgId,
            ...(aiValue != null ? { aiValue } : {}),
            ...(aiComment ? { aiComment } : {}),
          },
        });
      } catch (e) {
        console.warn(`correction postScore failed (run ${data.runId}):`, e);
      }
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
    const { runtime, models } = await getLatch();
    // Ask for one rubric PER DISTINCT QUALITY rather than one rubric flat: a
    // request like "uses the tool and follows the style" is two measurements,
    // and demanding a single rubric forces them into one prompt whose score
    // nobody can act on — a 0 no longer says which half broke.
    const brief =
      `Agent: ${normalizeAgentName(data.agent)}. Author online-eval rubric(s) measuring this quality: ` +
      `"${quality}". Usually ONE rubric — but if the description bundles several separable qualities, ` +
      `return one rubric per quality. Return the JSON array per your output contract.`;

    const draft = async (prompt: string) => {
      const { answer } = await runtime.runAgent({ principal, agent: "eval-author", prompt });
      return parseFencedJson<AttachedEval[] | { error: string }>(answer);
    };

    const knownModelId = (id: string) => models.some((m) => m.id === id);
    let parsed = await draft(brief);
    if (!parsed) return { ok: false as const, error: "eval-author returned no valid JSON" };
    if (!Array.isArray(parsed)) {
      return { ok: false as const, error: parsed.error ?? "eval-author could not draft a rubric" };
    }

    // Validate with the SAME gate the save will apply. Without this the drawer
    // happily shows a draft (over-long prompt, bad name) that cannot be
    // stored, and the user meets the rule only as a red error under work they
    // did not write. One corrective retry, because the usual break — a prompt
    // over 1000 chars — is one the author can fix if simply told.
    let valid = validateRubrics(parsed, knownModelId);
    if (!valid.ok) {
      const retry = await draft(
        `${brief}\n\nYour previous draft was REJECTED by the save validator with: "${valid.error}". ` +
          `Return a corrected JSON array. If a prompt ran over 1000 characters, SPLIT it into ` +
          `separate rubrics rather than compressing it.`,
      );
      if (Array.isArray(retry)) {
        const revalidated = validateRubrics(retry, knownModelId);
        if (revalidated.ok) {
          parsed = retry;
          valid = revalidated;
        }
      }
    }
    if (!valid.ok) return { ok: false as const, error: valid.error };
    return { ok: true as const, rubrics: valid.rubrics };
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
      /** Whose grants turns use — see SlackApp.credentialMode. Default per-user. */
      credentialMode?: "per-user" | "shared";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials, agentStore } = await getLatch();

    // An `api_app_id` is visible to every member of the hosting Slack workspace
    // and echoed in every event payload. RECONFIGURING an existing binding needs
    // the same creator gate as unbinding, not just a same-org check: the three
    // credentials below are stored at "org" scope, so any other member of the
    // owning org could otherwise overwrite the binding's Slack secrets and break
    // (or repoint) it. Checked BEFORE any write; `bind` is guarded too. A binding
    // with no recorded creator is unmanageable — `canManageBot` fails closed.
    const existing = await slackStore.resolve(data.appId);
    if (existing && !canManageBot(existing, principal)) {
      return { ok: false as const, error: "app already bound" };
    }

    const keys = slackVaultKeys(data.appId);
    await credentials.set(principal, keys.clientId, "org", data.clientId);
    await credentials.set(principal, keys.clientSecret, "org", data.clientSecret);
    await credentials.set(principal, keys.signingSecret, "org", data.signingSecret);

    // One lookup for both the pinned scope and the display title (see
    // `boundAgentRecord`); fall back to the directory for code-registry agents,
    // which have no stored record.
    const record = await boundAgentRecord(agentStore, principal, data.agent);
    const botName =
      record.title ??
      (await runtime.listAgents(principal)).find((a) => a.name === data.agent)?.title ??
      data.agent;
    const bound = await slackStore.bind({
      appId: data.appId,
      agent: data.agent,
      agentScope: record.scope,
      orgId: principal.orgId,
      userId: principal.userId,
      botName,
      credentialMode: data.credentialMode,
    });
    if (!bound) return { ok: false as const, error: "app already bound" };
    // The generated manifest is the v2 (agent_view) shape.
    await slackStore.setManifestVersion(data.appId, principal.orgId, 2);

    const authorizeUrl =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(data.clientId)}` +
      `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(","))}` +
      `&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}` +
      `&state=${encodeURIComponent(buildOauthState(data.appId, { userId: principal.userId!, manifestVersion: 2 }))}`;
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
    // Ownership check, same gate as every other channel binding — without it any
    // authenticated user could delete any org's binding by app id.
    const app = await slackStore.resolve(appId);
    if (!app || !canManageBot(app, principal)) return { ok: false };
    // The binding's Vault secrets go with it — bot token, signing secret and
    // client creds must not outlive the binding (telegram/whatsapp parity).
    const { credentials } = await getLatch();
    for (const key of Object.values(slackVaultKeys(appId))) {
      await credentials.remove(principal, key, "org").catch(() => {});
    }
    await slackStore.unbind(appId, principal.orgId);
    return { ok: true };
  });

/**
 * Binding health for the editor's Slack card: token liveness (auth.test),
 * whether events are arriving, and what the v2 channel requires (bot user id,
 * manifest version). Org-member readable; secrets never leave the server.
 */
export const slackAppHealthFn = createServerFn({ method: "GET" })
  .validator((appId: string) => appId)
  .handler(async ({ data: appId }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { slackStore, credentials } = await getLatch();
    const app = await slackStore.resolve(appId);
    if (!app || app.orgId !== principal.orgId) return null;
    const token = await credentials.get(
      { orgId: app.orgId, userId: app.userId },
      slackVaultKeys(appId).botToken,
      "org",
    );
    const auth = token ? await authTest(token).catch(() => ({ ok: false })) : { ok: false };
    return {
      status: app.status ?? "active",
      disabledReason: app.disabledReason,
      manifestVersion: app.manifestVersion ?? 1,
      hasBotUserId: Boolean(app.botUserId && app.teamId),
      lastEventAt: app.lastEventAt ?? null,
      tokenOk: auth.ok,
      unattendedChannels: app.unattendedChannels ?? [],
      streamError: app.lastStreamError ?? null,
    };
  });

/** Public channels the bot can see — options for the unattended allowlist. */
export const slackAppChannelsFn = createServerFn({ method: "GET" })
  .validator((appId: string) => appId)
  .handler(async ({ data: appId }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { slackStore, credentials } = await getLatch();
    const app = await slackStore.resolve(appId);
    if (!app || app.orgId !== principal.orgId) return [];
    const token = await credentials.get(
      { orgId: app.orgId, userId: app.userId },
      slackVaultKeys(appId).botToken,
      "org",
    );
    if (!token) return [];
    try {
      return await slackApi(token).conversationsList();
    } catch {
      return [];
    }
  });

/** Save the post_to_channel unattended allowlist (creator-gated). */
export const updateSlackAppSettingsFn = createServerFn({ method: "POST" })
  .validator((data: { appId: string; unattendedChannels: string[] }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { slackStore } = await getLatch();
    const app = await slackStore.resolve(data.appId);
    if (!app || !canManageBot(app, principal)) return { ok: false };
    // Channel ids only — names would silently stop matching on a rename.
    const channels = [...new Set(data.unattendedChannels)]
      .filter((c) => /^[CG][A-Z0-9]{4,}$/.test(c))
      .slice(0, 50);
    await slackStore.setUnattendedChannels(data.appId, principal.orgId, channels);
    return { ok: true, channels };
  });

/**
 * Migrate a binding to the v2 (agent_view) manifest: push the new manifest via
 * apps.manifest.update (config token, rotate-on-expiry), then hand back the
 * reinstall URL whose signed state flips `manifest_version` only after the
 * OAuth exchange succeeds. Without a config token the manifest JSON is
 * returned for the manual paste path. NOTE: Slack treats the agent_view flip
 * as one-way.
 */
export const migrateSlackAppFn = createServerFn({ method: "POST" })
  .validator((appId: string) => appId)
  .handler(async ({ data: appId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials, agentStore } = await getLatch();
    const app = await slackStore.resolve(appId);
    if (!app || !canManageBot(app, principal)) return { ok: false as const, error: "not_found" };

    const record = await boundAgentRecord(agentStore, principal, app.agent);
    const info = (await runtime.listAgents(principal)).find((a) => a.name === app.agent);
    const manifest = slackManifest({
      displayName: app.botName ?? record.title ?? info?.title ?? app.agent,
      description: info?.description,
      requestUrl: `${baseUrl()}/api/slack`,
      redirectUrl: `${baseUrl()}/api/slack/oauth`,
    });

    const clientId = await credentials.get(principal, slackVaultKeys(appId).clientId, "org");
    if (!clientId) return { ok: false as const, error: "no_client_id" };
    const reinstallUrl =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(","))}` +
      `&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}` +
      `&state=${encodeURIComponent(buildOauthState(appId, { userId: principal.userId!, manifestVersion: 2 }))}`;

    const configToken = await credentials.get(principal, SLACK_CONFIG_TOKEN_KEY, "org");
    if (!configToken) {
      return {
        ok: true as const,
        updated: false,
        manifestJson: JSON.stringify(manifest, null, 2),
        reinstallUrl,
      };
    }
    const refreshToken =
      (await credentials.get(principal, SLACK_CONFIG_REFRESH_KEY, "org")) ?? undefined;
    try {
      await updateAppManifest({
        configToken,
        refreshToken,
        appId,
        manifest,
        onRotate: async (rot) => {
          await credentials.set(principal, SLACK_CONFIG_TOKEN_KEY, "org", rot.token);
          await credentials.set(principal, SLACK_CONFIG_REFRESH_KEY, "org", rot.refreshToken);
        },
      });
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "update_failed" };
    }
    return { ok: true as const, updated: true, reinstallUrl };
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
  // Legacy string input = { agent } — callers predate the credential-mode flag.
  .validator((data: string | { agent: string; credentialMode?: "per-user" | "shared" }) =>
    typeof data === "string" ? { agent: data } : data,
  )
  .handler(async ({ data: { agent, credentialMode } }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials, agentStore } = await getLatch();

    const configToken = await credentials.get(principal, SLACK_CONFIG_TOKEN_KEY, "org");
    if (!configToken) return { ok: false as const, error: "no_config_token" };
    const refreshToken =
      (await credentials.get(principal, SLACK_CONFIG_REFRESH_KEY, "org")) ?? undefined;

    const info = (await runtime.listAgents(principal)).find((a) => a.name === agent);
    if (!info) return { ok: false as const, error: "unknown_agent" };
    // The pinned record decides the title too, so the app we create is named
    // after the agent the binding will actually run (see `boundAgentRecord`).
    const record = await boundAgentRecord(agentStore, principal, agent);
    const displayName = record.title ?? info.title ?? agent;

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
    // Slack minted this app id, so a cross-org conflict shouldn't happen —
    // report it rather than silently reporting success if it ever does.
    const bound = await slackStore.bind({
      appId: created.appId,
      agent,
      agentScope: record.scope,
      orgId: principal.orgId,
      userId: principal.userId,
      botName: displayName,
      credentialMode,
    });
    if (!bound) return { ok: false as const, error: "app already bound" };
    // Created from the v2 (agent_view) manifest.
    await slackStore.setManifestVersion(created.appId, principal.orgId, 2);

    // Send the installer to Slack; we carry the app id back via `state`.
    const sep = created.oauthAuthorizeUrl.includes("?") ? "&" : "?";
    const authorizeUrl = `${created.oauthAuthorizeUrl}${sep}state=${encodeURIComponent(buildOauthState(created.appId, { userId: principal.userId!, manifestVersion: 2 }))}&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}`;
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

// ── Telegram channel: per-agent bot onboarding ───────────────────────────────

/**
 * Editor-side authorization for a channel bot binding: same org, and — since a
 * binding is created by (and may serve) one specific member's personal agent —
 * only its creator may see or manage it. A binding without a recorded creator
 * is unmanageable (fail closed) — org-shared management would need an explicit
 * role gate; until then every binding is creator-owned.
 */
const canManageBot = (
  bot: { orgId: string; userId?: string },
  principal: { orgId: string; userId?: string },
): boolean => bot.orgId === principal.orgId && !!bot.userId && bot.userId === principal.userId;

/**
 * The agent record a new channel binding will serve — personal wins on a name
 * clash, mirroring turn-time resolution (agent-store `find`). Its scope is
 * persisted on the bot row so webhook turns pin resolution to this exact
 * record. Undefined = not in the store (a code-registry agent).
 *
 * Callers that also need a display title must take it from THIS record, not from
 * a separate `runtime.listAgents` lookup: that directory lists code-declared
 * agents first and stored ones unordered-by-scope, so on a name clash the two
 * can disagree — pinning one record while displaying another's title.
 */
const boundAgentRecord = async (
  agentStore: {
    listRecords: (p: {
      orgId: string;
      userId?: string;
    }) => Promise<{ name: string; scope: string; title?: string }[]>;
  },
  principal: { orgId: string; userId?: string },
  agent: string,
): Promise<{ scope?: "org" | "user"; title?: string }> => {
  const records = await agentStore.listRecords(principal);
  const match =
    records.find((r) => r.name === agent && r.scope === "user") ??
    records.find((r) => r.name === agent);
  return {
    scope: match?.scope === "org" || match?.scope === "user" ? match.scope : undefined,
    title: match?.title,
  };
};

// ── DM channels: per-agent bot onboarding, one set of functions for every kind ─
// (`channel-kinds.ts` holds what differs: credential validation, Vault keys,
// webhook hookup.) The editor's `ChannelSection` is the only caller.

/** A DM bot with its webhook URL; `canManageBot`-filtered to the caller's own. */
async function manageableBot(kind: DmChannelKind, botId: string) {
  const principal = await getPrincipal();
  if (!principal) return null;
  const { channelStore, credentials } = await getLatch();
  const bot = await channelStore.getBot(kind, botId);
  if (!bot || !canManageBot(bot, principal)) return null;
  const def = CHANNEL_KINDS[kind];
  const ctx: KindCtx = { principal, credentials, botId, eventsUrl: `${baseUrl()}${def.eventsPath(botId)}` };
  return { bot, def, ctx, channelStore };
}

const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) });

/** The caller's bots of one kind (for the editor's status view). */
export const listChannelBotsFn = createServerFn({ method: "GET" })
  .validator((kind: DmChannelKind) => kind)
  .handler(async ({ data: kind }) => {
    const principal = await getPrincipal();
    if (!principal || !isDmChannelKind(kind)) return [];
    const { channelStore } = await getLatch();
    const bots = await channelStore.listBots(kind, principal.orgId);
    return bots
      .filter((b) => canManageBot(b, principal))
      .map((b) => ({ ...b, eventsUrl: `${baseUrl()}${CHANNEL_KINDS[kind].eventsPath(b.id)}` }));
  });

/** Create a bot row for an agent (credentials are pasted in a second step). */
export const createChannelBotFn = createServerFn({ method: "POST" })
  .validator((data: { kind: DmChannelKind; agent: string; handle: string; displayName?: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    if (!isDmChannelKind(data.kind)) return { ok: false as const, error: "unknown channel" };
    const { channelStore, agentStore } = await getLatch();
    const id = crypto.randomUUID();
    try {
      await channelStore.createBot({
        kind: data.kind,
        id,
        agent: data.agent,
        agentScope: (await boundAgentRecord(agentStore, principal, data.agent)).scope,
        orgId: principal.orgId,
        userId: principal.userId,
        handle: data.handle.trim(),
        displayName: data.displayName?.trim() || undefined,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: m.includes("UNIQUE") ? "handle already taken" : m };
    }
    return { ok: true as const, botId: id };
  });

/**
 * Save pasted credentials: validate them against the platform, store them in
 * the Vault (plus any server-generated secrets), record the platform handle.
 */
export const saveChannelBotCredentialsFn = createServerFn({ method: "POST" })
  .validator((data: { kind: DmChannelKind; botId: string; credentials: Record<string, string> }) => data)
  .handler(async ({ data }) => {
    if (!isDmChannelKind(data.kind)) return { ok: false as const, error: "unknown channel" };
    const m = await manageableBot(data.kind, data.botId);
    if (!m) return { ok: false as const, error: "not found" };
    let externalHandle: string;
    try {
      ({ externalHandle } = await m.def.validate(data.credentials));
      await m.def.saveCredentials(m.ctx, data.credentials);
    } catch (e) {
      return fail(e);
    }
    // A credential save on a register-mode kind rotates the webhook secret, so the
    // registration mark is reset — the operator must register again.
    await m.channelStore.setExternalHandle(data.kind, data.botId, externalHandle, {
      resetWebhook: m.def.webhook === "register",
    });
    return { ok: true as const, externalHandle };
  });

/** Register (or re-register) the bot's webhook with the platform (register-mode kinds). */
export const registerChannelWebhookFn = createServerFn({ method: "POST" })
  .validator((data: { kind: DmChannelKind; botId: string }) => data)
  .handler(async ({ data }) => {
    if (!isDmChannelKind(data.kind)) return { ok: false as const, error: "unknown channel" };
    const m = await manageableBot(data.kind, data.botId);
    if (!m) return { ok: false as const, error: "not found" };
    if (!m.def.registerWebhook) return { ok: false as const, error: "this channel's webhook is configured in its dashboard" };
    try {
      await m.def.registerWebhook(m.ctx);
    } catch (e) {
      return fail(e);
    }
    await m.channelStore.markWebhookRegistered(data.kind, data.botId);
    return { ok: true as const };
  });

/** The webhook panel: platform-side status, or the values a dashboard needs. */
export const channelWebhookInfoFn = createServerFn({ method: "GET" })
  .validator((data: { kind: DmChannelKind; botId: string }) => data)
  .handler(async ({ data }) => {
    if (!isDmChannelKind(data.kind)) return null;
    const m = await manageableBot(data.kind, data.botId);
    if (!m) return null;
    try {
      return await m.def.webhookInfo(m.ctx);
    } catch {
      return null;
    }
  });

/**
 * Delete a bot binding: platform cleanup, then its Vault secrets, then the
 * rows. The first two are best-effort — a Vault or platform hiccup must not
 * leave the bot half-deleted with no way to retry from the editor; the row
 * deletion is always reached, and anything left behind is logged.
 */
export const deleteChannelBotFn = createServerFn({ method: "POST" })
  .validator((data: { kind: DmChannelKind; botId: string }) => data)
  .handler(async ({ data }) => {
    if (!isDmChannelKind(data.kind)) return { ok: false as const, error: "unknown channel" };
    const m = await manageableBot(data.kind, data.botId);
    if (!m) return { ok: false as const, error: "not found" };
    await m.def.beforeDelete?.(m.ctx).catch((e) => {
      console.error(`[${data.kind}] pre-delete cleanup failed for ${data.botId}:`, e);
    });
    // The binding's Vault secrets go with it — deleting a bot must not leave
    // its tokens stored indefinitely.
    for (const key of Object.values(m.def.vaultKeys(data.botId))) {
      await m.ctx.credentials.remove(m.ctx.principal, key, "org").catch((e) => {
        console.error(`[${data.kind}] could not remove Vault key ${key}:`, e);
      });
    }
    await m.channelStore.removeBot(data.kind, data.botId);
    return { ok: true as const };
  });

// ── Eval sets: per-input cases, run against a pinned configuration ──────────
//
// The other tier. A RUBRIC is one question asked of every input ("is every
// claim grounded?"); a CASE is one input with expectations for THAT input
// ("asked about VPC limits → must open docs/networking/vpc-limits.md").
// Only the case tier can express "different questions should read different
// documents", because only it knows what was asked.
//
// EXPERIMENTAL. These back the /evals page and are expected to change shape.

/** Every set the caller can see, newest agent first. */
export const listEvalSetsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [] as { agentName: string; name: string; cases: number; updatedAt: number }[];
  const { evalStore } = await getLatch();
  const sets = (
    await Promise.all(evalOwnerKeysOf(principal).map((owner) => evalStore.listSets(owner)))
  ).flat();
  return sets.map((s) => ({
    agentName: s.agentName,
    name: s.name,
    cases: s.cases.length,
    updatedAt: s.updatedAt,
  }));
});

export const getEvalSetFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; name: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { evalStore } = await getLatch();
    for (const owner of evalOwnerKeysOf(principal)) {
      const set = await evalStore.getSet(owner, normalizeAgentName(data.agent), data.name);
      if (set) return set;
    }
    return null;
  });

export const saveEvalSetFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; name: string; cases: EvalCase[] }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { agentStore, evalStore } = await getLatch();
    const agentName = normalizeAgentName(data.agent);
    const rec = await agentStore.getRecord(principal, agentName);
    // Sets are owned by the AGENT's owner, like its rubrics — so a colleague
    // who can administer the agent sees them, and someone who merely runs it
    // does not.
    if (!rec) return { ok: false as const, error: `No editable agent "${agentName}".` };
    const ids = data.cases.map((c) => c.id);
    const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupe) {
      // Case ids are the pairing key for a version comparison; duplicates would
      // silently merge two cases into one column.
      return { ok: false as const, error: `Duplicate case id "${dupe}".` };
    }
    const blank = data.cases.find((c) => !c.id.trim() || !c.input.trim());
    if (blank) return { ok: false as const, error: "Every case needs an id and an input." };

    await evalStore.saveSet({
      owner: evalOwnerOfRecord(principal, rec),
      agentName,
      name: data.name,
      cases: data.cases,
    });
    return { ok: true as const };
  });

export const deleteEvalSetFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; name: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { agentStore, evalStore } = await getLatch();
    const agentName = normalizeAgentName(data.agent);
    const rec = await agentStore.getRecord(principal, agentName);
    if (!rec) return { ok: false as const, error: `No editable agent "${agentName}".` };
    await evalStore.deleteSet(evalOwnerOfRecord(principal, rec), agentName, data.name);
    return { ok: true as const };
  });

/**
 * Run a set against ONE configuration of the agent.
 *
 * `version` pins which: a published version number, `"draft"`, or omitted for
 * whatever is live. The pin is a reference (`name@7`), resolved read-only —
 * running a version never makes it live, which is what allows two versions to
 * be compared while neither is serving different traffic than the other.
 */
export const runEvalSetFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; name: string; version?: number | "draft" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, agentStore, evalStore, modelFor } = await getLatch();
    const agentName = normalizeAgentName(data.agent);
    const rec = await agentStore.getRecord(principal, agentName);
    if (!rec) return { ok: false as const, error: `No editable agent "${agentName}".` };

    const owner = evalOwnerOfRecord(principal, rec);
    const set = await evalStore.getSet(owner, agentName, data.name);
    if (!set?.cases.length) return { ok: false as const, error: `Eval set "${data.name}" is empty.` };

    const ref = data.version === undefined ? agentName : `${agentName}@${data.version}`;
    // Snapshot what ACTUALLY ran, not what is live: a run compared later is
    // only interpretable next to the configuration that produced it.
    const snapshot =
      typeof data.version === "number"
        ? ((await agentStore.getVersion(principal, agentName, rec.scope ?? "user", data.version)) ?? null)
        : data.version === "draft"
          ? ((await agentStore.getDraft(principal, agentName, rec.scope ?? "user"))?.record ?? null)
          : rec;
    if (!snapshot) return { ok: false as const, error: `No configuration "${ref}".` };

    const needsJudge = set.cases.some((c) => c.expected.rubric?.length);
    const needsChecks = set.cases.some((c) => c.checks && Object.keys(c.checks).length > 0);
    const results = await runEvalCases({
      runtime,
      principal,
      agent: ref,
      cases: set.cases,
      // The case tier's plain-language criteria still use a TEXT judge: it
      // returns a reason per criterion, which the results card shows.
      ...(needsJudge ? { judgeModel: modelFor(EXPLAIN_MODEL_ID) } : {}),
      // A case's typed `checks` go to the same evaluation judge that answers
      // questions about live traffic — one judge, one vocabulary.
      ...(needsChecks ? { judge: judgeModel(JUDGE_MODEL_ID) } : {}),
    });

    const run = await evalStore.saveRun({
      owner,
      agentName,
      setName: data.name,
      // An AgentRecord is JSON by construction — it round-trips through the
      // agents table as a JSON column — but it is not provably so to the type
      // checker, because `trigger` is deliberately opaque there.
      agentSnapshot: snapshot as unknown as JsonValue,
      results,
      passCount: results.filter((r) => r.pass).length,
      failCount: results.filter((r) => !r.pass).length,
      judgeModelId: needsJudge ? EXPLAIN_MODEL_ID : null,
      configRef: ref,
    });
    return { ok: true as const, run, ref };
  });

/** Recent runs of a set, newest first — one row per (version, run). */
export const listEvalRunsFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; name?: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { evalStore } = await getLatch();
    const agentName = normalizeAgentName(data.agent);
    const runs = (
      await Promise.all(
        evalOwnerKeysOf(principal).map((owner) =>
          evalStore.listRuns(owner, agentName, data.name, data.limit ?? 20),
        ),
      )
    ).flat();
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  });

/**
 * Draft eval CASES from a description, or from a conversation that went wrong.
 *
 * The form is the wrong place to author these. A case's value is in its
 * GROUND TRUTH — the real tool name, the real argument key — and that is
 * exactly what a person should not be looking up by hand. So the human
 * describes intent and the Eval Author produces the concrete expectations,
 * having first read the agent's connections and their actual tool schemas.
 *
 * Whatever comes back is a DRAFT: it lands in the editor unsaved, for the
 * reviewer to cut down. Generated cases are cheap and a fair share are
 * trivial or accidentally unanswerable — deleting them is the job, not
 * authoring from scratch.
 */
export const draftEvalCasesFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; brief: string; threadId?: string; count?: number }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const brief = data.brief.trim();
    if (!brief && !data.threadId) {
      return { ok: false as const, error: "describe what to test, or name a conversation" };
    }
    const { runtime, agentStore, allConnections } = await getLatch();
    const agentName = normalizeAgentName(data.agent);
    const count = Math.min(Math.max(data.count ?? 5, 1), 15);

    // GROUND THE BRIEF DIRECTLY rather than instructing the author to go and
    // look. It can still call get_agent and list_connection_tools for more,
    // but the three things every case depends on — what the agent is told to
    // do, what it can actually call, and what the human asked for — are in
    // front of it from the first token. An instruction to fetch them is a
    // suggestion; a prompt that contains them is a fact.
    const rec = await agentStore.getRecord(principal, agentName);
    const connections = rec?.connections ?? [];
    let toolLines = "";
    if (connections.length) {
      const opened = await allConnections.hostFor(connections).open(principal);
      try {
        toolLines = Object.keys(opened.tools)
          .filter((k) => !k.startsWith("connect_"))
          .map((name) => {
            const d = (opened.tools[name] as { description?: string } | undefined)?.description;
            return `- ${name}${d ? `: ${d.slice(0, 160)}` : ""}`;
          })
          .join("\n");
      } finally {
        await opened.close();
      }
    }

    const grounding =
      (rec?.instructions
        ? `\n\nTHE AGENT'S OWN INSTRUCTIONS (its system prompt — the behaviour a case is measuring against):\n${rec.instructions.slice(0, 6000)}`
        : "") +
      (toolLines
        ? `\n\nTOOLS IT CAN ACTUALLY CALL (use these names EXACTLY; call list_connection_tools if you need a tool's argument schema):\n${toolLines}`
        : "\n\nThis agent has no connection tools.");

    const prompt =
      `Agent: ${agentName}. Author up to ${count} EVAL CASES.` +
      (brief ? ` What to cover: "${brief}".` : "") +
      (data.threadId
        ? ` Build them from the conversation in thread ${data.threadId}: read_transcript it, ` +
          `use what the user actually asked as the input, and make the expectations describe what ` +
          `SHOULD have happened.`
        : "") +
      ` Derive the cases from the agent's own instructions below: the behaviours it PROMISES are ` +
      `the behaviours worth testing, and a promise it makes that nothing checks is the gap to ` +
      `close first. Use the tool names exactly as given. Return the JSON array per your output ` +
      `contract.` +
      grounding;

    const { answer } = await runtime.runAgent({ principal, agent: "eval-author", prompt });
    const parsed = parseFencedJson<EvalCase[] | { error: string }>(answer);
    if (!parsed) return { ok: false as const, error: "eval-author returned no valid JSON" };
    if (!Array.isArray(parsed)) {
      return { ok: false as const, error: parsed.error ?? "eval-author could not draft cases" };
    }

    // Shape-check rather than trust: a case with no input runs nothing, and a
    // duplicate id silently merges two cases into one column in a comparison.
    const seen = new Set<string>();
    const cases = parsed.filter((c) => {
      const ok = !!c?.id?.trim() && !!c?.input?.trim() && !seen.has(c.id);
      if (ok) seen.add(c.id);
      return ok;
    });
    if (cases.length === 0) return { ok: false as const, error: "no usable cases were drafted" };
    return { ok: true as const, cases };
  });
