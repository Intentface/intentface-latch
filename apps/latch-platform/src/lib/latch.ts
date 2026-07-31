import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  createRuntime,
  createVault,
  defineContext,
  mergeConnections,
  mergeToolSources,
} from "@intentface/latch-core";
import type { LanguageModel } from "ai";
import type {Runtime, ConnectionRegistry} from "@intentface/latch-core";
import {
  createMemoryJobStore,
  createSqliteAdapter,
  createSqliteSecretStore,
  migrate,
  schema,
} from "@intentface/latch-drizzle";
import { createLoredexStore, createMemoryProvider, scopeRefOf } from "@intentface/latch-memory";
import type { MemoryJobStore, MemoryStore } from "@intentface/latch-memory";
import { isLangfuseConfigured, langfuseTelemetry } from "@intentface/latch-langfuse";
import { waitUntil } from "@vercel/functions";
import { createMcpConnections  } from "@intentface/latch-mcp";
import type {McpConnections} from "@intentface/latch-mcp";
import { createLatchHandler  } from "@intentface/latch-server";
import type {LatchHandler} from "@intentface/latch-server";
import { Cron } from "croner";
import { connectionDefs } from "@/connections";
import { agents } from "@/agents";
import { secretEnv } from "./env";
import { getPrincipalFromHeaders  } from "./session";
import type {Principal} from "./session";
import { createCredentials  } from "./credentials";
import type {Credentials} from "./credentials";
import { createConnectionStore  } from "./connection-store";
import type {ConnectionStore} from "./connection-store";
import { createDynamicConnections  } from "./dynamic-connections";
import type {DynamicConnections} from "./dynamic-connections";
import { createAgentStore, migrateAgents  } from "./agent-store";
import type {AgentStore} from "./agent-store";
import { createSlackStore, migrateSlack, slackVaultKeys } from "./slack-store";
import type {SlackStore} from "./slack-store";
import { createTelegramStore, migrateTelegram } from "./telegram-store";
import type {TelegramStore} from "./telegram-store";
import { createWhatsappStore, migrateWhatsapp } from "./whatsapp-store";
import type {WhatsappStore} from "./whatsapp-store";
import { createToolStore, migrateAuthoredTools  } from "./tools/store";
import type {ToolStore} from "./tools/store";
import { createEvalStore, migrateEvals } from "./evals/store";
import type {EvalStore} from "./evals/store";
import { createRunScoresStore, migrateRunScores } from "./observability/run-scores-store";
import type {RunScoresStore} from "./observability/run-scores-store";
import type { UserProfile } from "./observability/runners";
import { createAuthoredTools  } from "./tools";
import type {AuthoredToolsApi} from "./tools";
import { baseUrl } from "./base-url";
import { loadModelCatalog  } from "./models";
import type {ModelInfo} from "./models";
import { createSandboxResolver, harnessTools } from "./sandbox";
import {
  createGoogleWorkspaceConnection,
  createGoogleWorkspaceWriteConnection,
} from "./google-workspace";
import { resolveProviderTools } from "./provider-tools";
import { makeResolveReasoningOptions } from "./reasoning";

/** Our typed runtime context (built per turn from the principal). */
interface Ctx {
  orgId: string;
  /** The logged-in user, resolved from better-auth — absent for org-only principals. */
  user?: { name?: string; email?: string };
}

/**
 * The Langfuse tenant tag for a principal — the same derivation as the
 * storage owner key, URL-encoded and joined. Telemetry WRITES tag traces with
 * it (userId + `owner:` tag) and observability READS filter on it, so both
 * sides must use this one function.
 */
export const ownerTagOf = (p: Principal): string =>
  (p.userId ? [p.orgId, p.userId] : [p.orgId]).map(encodeURIComponent).join("/");

/**
 * The platform's Latch composition root — built lazily, memoized per process.
 *
 * This is the whole integration: a runtime over the shared libsql DB, the MCP
 * connection registry built from `connections/`, agents from `agents/`, and ONE
 * mountable handler (`/api/latch/*`). Isolation lives in the adapter/secret-store
 * via the `owner` key we derive from our Principal — here, per (org, user).
 */
let cached:
  | {
      runtime: Runtime<Principal>;
      connections: McpConnections<Principal>;
      credentials: Credentials;
      connectionStore: ConnectionStore;
      dynamic: DynamicConnections;
      allConnections: ConnectionRegistry<Principal>;
      agentStore: AgentStore;
      slackStore: SlackStore;
      telegramStore: TelegramStore;
      whatsappStore: WhatsappStore;
      toolStore: ToolStore;
      authoredTools: AuthoredToolsApi;
      evalStore: EvalStore;
      runScores: RunScoresStore;
      models: ModelInfo[];
      modelFor: (id: string) => LanguageModel;
      handler: LatchHandler;
      memoryStore: MemoryStore<Principal>;
      memoryJobs: MemoryJobStore;
      /** Batch user-profile lookup (cached) — runner attribution on /observability. */
      resolveUsers: (userIds: string[]) => Promise<Map<string, UserProfile>>;
    }
  | undefined;

export async function getLatch(): Promise<{
  runtime: Runtime<Principal>;
  connections: McpConnections<Principal>;
  credentials: Credentials;
  connectionStore: ConnectionStore;
  dynamic: DynamicConnections;
  allConnections: ConnectionRegistry<Principal>;
  agentStore: AgentStore;
  slackStore: SlackStore;
  telegramStore: TelegramStore;
  whatsappStore: WhatsappStore;
  toolStore: ToolStore;
  authoredTools: AuthoredToolsApi;
  evalStore: EvalStore;
  runScores: RunScoresStore;
  models: ModelInfo[];
  modelFor: (id: string) => LanguageModel;
  handler: LatchHandler;
  memoryStore: MemoryStore<Principal>;
  memoryJobs: MemoryJobStore;
  resolveUsers: (userIds: string[]) => Promise<Map<string, UserProfile>>;
}> {
  if (cached) return cached;

  // Local dev → a file DB; prod → a hosted libsql (Turso) URL + auth token.
  const client = createClient({
    url: process.env.DATABASE_URL ?? "file:./latch.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  await migrate(client); // creates latch_* tables alongside the auth tables
  await migrateAgents(client); // latch_agents (UI-created agents)
  await migrateSlack(client); // latch_slack_app + latch_slack_event (Slack channel)
  await migrateTelegram(client); // latch_telegram_* (Telegram channel)
  await migrateWhatsapp(client); // latch_whatsapp_* (WhatsApp channel)
  await migrateAuthoredTools(client); // latch_tools (authored, sandboxed fetch+compute tools)
  await migrateEvals(client); // latch_eval_sets + latch_eval_runs (agent eval loop)
  await migrateRunScores(client); // latch_run_scores (fast local mirror for the chat evals panel)

  // The ownership key — the isolation boundary. With a userId it's per-user
  // (`[org,user]`); a userId-stripped principal yields the org-shared owner
  // (`[org]`) — used for org-level credentials.
  const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);

  const db = drizzle(client, { schema }); // adapters take a pre-built drizzle db
  const storage = createSqliteAdapter<Principal>(db, { owner });
  const vault = createVault<Principal>({
    // Our driver-agnostic adapter API takes the pre-built drizzle `db`; main's
    // fail-closed `secretEnv` (throws in prod if the key is the dev default) is
    // kept — both improvements coexist.
    store: createSqliteSecretStore<Principal>(db, { owner }),
    masterKey: secretEnv("LATCH_VAULT_KEY", btoa("latch-dev-vault-key-32-bytes!!!!")),
  });
  const credentials = createCredentials(vault);
  const connectionStore = createConnectionStore(vault);
  // Model catalog + pricing from models.dev (filtered to Anthropic).
  const catalog = await loadModelCatalog();
  // Authored tools: sandboxed JS/TS programs over `input` + an allowlisted fetch.
  // Scoped personal (per org+user) or org (shared), mirroring agents/connections.
  const toolStore = createToolStore(client);
  const authoredTools = createAuthoredTools({
    store: toolStore,
    ownerKey: (p, scope) => {
      const pr = p as Principal;
      const parts = scope === "org" ? [pr.orgId] : [pr.orgId, pr.userId ?? ""];
      return parts.map(encodeURIComponent).join("/");
    },
  });
  // UI-created agents (latch_agents table, org/personal) — may attach authored
  // tools, resolved per caller at turn time. An org agent resolves only org
  // tools (so every member gets them); a personal agent merges org + personal.
  const agentStore = createAgentStore(client, catalog.modelFor, (p, names, scope) =>
    authoredTools.executableTools(p, names, scope),
  );
  const slackStore = createSlackStore(client);
  const telegramStore = createTelegramStore(client);
  const whatsappStore = createWhatsappStore(client);
  // Eval sets + persisted runs for the Agent Builder's evaluate→improve loop.
  const evalStore = createEvalStore(client);
  // Fast local mirror of per-run eval verdicts (the chat evals panel reads it).
  const runScores = createRunScoresStore(client);

  // Resolve the principal's user row, cached with a short TTL — agents (e.g. the
  // anchor interview/orient pair) read `runtime.user` to know who they're talking
  // to. The TTL keeps better-auth profile edits surfacing without a restart; a
  // failed query is never memoized (it would pin `runtime.user` to undefined for
  // the process lifetime) — fall back to the last known value instead.
  const USER_TTL_MS = 5 * 60_000;
  const USER_CACHE_MAX = 1_000;
  const userCache = new Map<string, { at: number; value?: UserProfile }>();

  /** Evict expired entries at the cap, then the oldest-inserted if still full. */
  function boundUserCache() {
    if (userCache.size < USER_CACHE_MAX) return;
    // Bound the cache: TTL alone never evicts users that stop being queried.
    // Sweep expired entries at the cap; if every entry is still live, drop the
    // oldest-inserted (Map preserves insertion order).
    const now = Date.now();
    for (const [k, v] of userCache) if (now - v.at >= USER_TTL_MS) userCache.delete(k);
    while (userCache.size >= USER_CACHE_MAX) {
      const oldest = userCache.keys().next().value;
      if (oldest === undefined) break;
      userCache.delete(oldest);
    }
  }

  /**
   * Batch profile lookup for the observability feed's runner attribution — one
   * query for every cache miss. A failed query is never memoized (it would pin
   * the entry to undefined for the process lifetime); the last known value stands.
   */
  async function resolveUsers(userIds: string[]): Promise<Map<string, UserProfile>> {
    const out = new Map<string, UserProfile>();
    const now = Date.now();
    const missing: string[] = [];
    for (const id of new Set(userIds)) {
      const hit = userCache.get(id);
      if (hit && now - hit.at < USER_TTL_MS) {
        if (hit.value) out.set(id, hit.value);
      } else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
      const placeholders = missing.map(() => "?").join(",");
      const res = await client.execute({
        sql: `SELECT id, name, email FROM user WHERE id IN (${placeholders})`,
        args: missing,
      });
      const found = new Set<string>();
      for (const row of res.rows as unknown as Record<string, unknown>[]) {
        const id = String(row.id);
        const value: UserProfile = {
          name: (row.name as string) || undefined,
          email: (row.email as string) || undefined,
        };
        found.add(id);
        boundUserCache();
        userCache.set(id, { at: Date.now(), value });
        out.set(id, value);
      }
      // Cache the misses too, so an unknown id doesn't re-query every poll.
      for (const id of missing) {
        if (found.has(id)) continue;
        boundUserCache();
        userCache.set(id, { at: Date.now(), value: undefined });
      }
    } catch (e) {
      console.warn("resolveUsers failed:", e instanceof Error ? e.message : e);
      // Fall back to whatever is still cached (possibly stale) for the misses.
      for (const id of missing) {
        const stale = userCache.get(id)?.value;
        if (stale) out.set(id, stale);
      }
    }
    return out;
  }

  const resolveUser = async (userId: string): Promise<UserProfile | undefined> =>
    (await resolveUsers([userId])).get(userId);

  const context = defineContext<Principal, Ctx>({
    build: async ({ principal }) => ({
      orgId: principal.orgId,
      ...(principal.userId ? { user: await resolveUser(principal.userId) } : {}),
    }),
  });

  // MCP connections, declared in `connections/`. SSRF allowlist derives from the
  // connection URLs; the OAuth callback base must match the mounted handler.
  // Shared canonical origin so connection callbacks agree with auth + Slack.
  const baseURL = baseUrl();
  const allowedHosts = Object.values(connectionDefs).map((c) => new URL(c.url).hostname);

  // UI-added connections (Vault-stored, org/personal), resolved by name per
  // turn. MCP ones can use static-token OR interactive OAuth — the callback
  // lands on the same handler base as code connections.
  const dynamic = createDynamicConnections({
    store: connectionStore,
    vault,
    callbackBaseUrl: `${baseURL}/api/latch/connections`,
    onConnectionError: (name, err) =>
      console.warn(`Dynamic connection "${name}" skipped:`, err instanceof Error ? err.message : err),
  });

  const connections = createMcpConnections<Principal>({
    vault,
    secrets: vault.resolver,
    allowedHosts,
    connections: connectionDefs,
    callbackBaseUrl: `${baseURL}/api/latch/connections`,
    onConnectionError: (name, err) =>
      console.warn(`MCP "${name}" skipped:`, err instanceof Error ? err.message : err),
  });

  // Google Workspace OAuth: the tool-less read connection (mirage's read-only
  // mounts ARE the interface) and its write companion (approval-gated
  // gmail_send, separate consent/grant so the mount token never gains write
  // scopes). Both need the same pre-registered OAuth client (no DCR), separate
  // from the Google login and Calendar clients. Omitted (no client id) → not
  // loaded.
  const googleClient = process.env.GOOGLE_WORKSPACE_CLIENT_ID
    ? {
        vault,
        clientId: process.env.GOOGLE_WORKSPACE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_WORKSPACE_CLIENT_SECRET ?? "",
        callbackBaseUrl: `${baseURL}/api/latch/connections`,
      }
    : undefined;
  const googleWorkspace = googleClient
    ? createGoogleWorkspaceConnection<Principal>(googleClient)
    : undefined;
  const googleExtras = googleClient
    ? [googleWorkspace!, createGoogleWorkspaceWriteConnection<Principal>(googleClient)]
    : [];

  // The code-declared built-ins across kinds (MCP + the google_workspace
  // pair) — one registry so the Connections page status list, the handler
  // routes, tool resolution, and any registry consumer see them all like any
  // other built-in.
  const builtinConnections: McpConnections<Principal> =
    googleExtras.length === 0
      ? connections
      : {
          host: connections.host,
          hostFor: (names) =>
            mergeToolSources(
              connections.hostFor(names),
              ...googleExtras.map((g) => g.hostFor(names)),
            ),
          names: [...connections.names, ...googleExtras.flatMap((g) => g.names)],
          oauth: (name) =>
            googleExtras.find((g) => g.names.includes(name))?.oauth(name) ??
            connections.oauth(name),
          status: async (p) =>
            (
              await Promise.all([
                connections.status(p),
                ...googleExtras.map((g) => g.status(p)),
              ])
            ).flat(),
          testTools: (name, p) =>
            googleExtras.find((g) => g.names.includes(name))?.testTools(name, p) ??
            connections.testTools(name, p),
        };

  // The full connection registry across kinds — also used to enumerate a
  // connection's tools for the agent editor. (google_workspace contributes no
  // tools — the mounts are its interface; google_workspace_write contributes
  // the approval-gated gmail_send.)
  const allConnections = mergeConnections(builtinConnections, dynamic);

  // Agent memory (see @intentface/latch-memory + PLAN.md "MemoryProvider"):
  // markdown in the agent's own Loredex connection, compiled index injected per
  // turn, background extraction/consolidation via the memory sweep (cron).
  const memoryJobs = createMemoryJobStore(db);
  const memoryStore = createLoredexStore<Principal>({ connections: allConnections });
  const MEMORY_TOUCH_COOLDOWN_MS = 6 * 3_600_000; // refined per agent by the sweep
  const memoryProvider = createMemoryProvider<Principal>({
    store: memoryStore,
    scopeOf: ({ principal, agent, memory }) =>
      scopeRefOf({ agent, memory, userId: principal.userId }),
    // Retention signal: recalled ids bump usage (expiry works off this).
    recordUsage: (scopeKey, ids) => memoryJobs.recordUsage(scopeKey, ids, Date.now()),
    // A memory_save episode marks the scope dirty for the next consolidation,
    // stamping the caller so the job can run under the scope's own principal.
    onEpisodeWritten: ({ scopeKey, connection, agent, principal, path }) =>
      memoryJobs.touchScope(
        {
          scopeKey,
          owner: ownerTagOf(principal),
          agent,
          connection,
          identity: principal,
          episodePath: path,
        },
        { cooldownMs: MEMORY_TOUCH_COOLDOWN_MS, now: Date.now() },
      ),
  });

  const runtime = createRuntime<Principal, Ctx>({
    storage,
    context,
    agents,
    // Resolve each agent's `connections: [...]` across code-declared MCP +
    // OpenAPI and the UI-added (Vault-stored) connections.
    connections: allConnections,
    // UI-created agents (not in the static `agents` registry).
    dynamicAgents: agentStore,
    // Persistent agent memory: injects the compiled index + memory tools into
    // any agent (code or UI) that declares `memory`.
    memory: memoryProvider,
    // Resume/cron: the run stored our Principal verbatim; pass it back as-is.
    reconstructPrincipal: (identity) => identity as Principal,
    durability: { enabled: true, leaseTtlMs: 30_000, heartbeatMs: 10_000 },
    // Cron evaluator for scheduled agents (croner). Interpreted in the
    // schedule's timezone (IANA) so "9am daily" means the user's 9am; defaults
    // to UTC when none is set.
    cron: (expr, afterMs, timezone) =>
      new Cron(expr, { timezone: timezone || "UTC" }).nextRun(new Date(afterMs))?.getTime() ??
      null,
    // Rates (USD per 1M tokens) from models.dev.
    pricing: catalog.pricing,
    // Per-session sandbox (one per chat) + the default harness tools. just-bash
    // is the zero-infra default; Daytona (opt-in) needs DAYTONA_API_KEY; mirage
    // (opt-in) mounts the agent's Slack app read-only when one is bound.
    sandbox: createSandboxResolver({
      slackTokenForAgent: async (agent, principal) => {
        const app = (await slackStore.listForOrg(principal.orgId)).find(
          (a) => a.agent === agent,
        );
        if (!app) return null;
        return (
          (await credentials.get(principal, slackVaultKeys(app.appId).botToken, "org")) ??
          null
        );
      },
      googleForUser: async (principal) =>
        (await googleWorkspace?.mountCredsFor(principal)) ?? null,
    }),
    harnessTools,
    // Native provider web tools (search/fetch) for agents that opt in.
    resolveProviderTools,
    // Per-agent reasoning effort → provider options (gated to reasoning models).
    resolveReasoningOptions: makeResolveReasoningOptions(catalog.models),
    // Langfuse observability (opt-in via LANGFUSE_* env): every run becomes a
    // trace tagged owner/agent/run; attached-eval judges + user feedback land
    // on it as scores. Absent keys → undefined → zero behavior change.
    telemetry: isLangfuseConfigured()
      ? langfuseTelemetry<Principal>({
          ownerTag: ownerTagOf,
          // Tag the trace with the AGENT's owner so /observability can show a
          // colleague's runs on the agents this reader administers. Undefined for
          // code-registry agents (no row) — the tag is simply omitted.
          agentOwnerTag: async (run) =>
            (await agentStore.getRecord(run.principal, run.agent))?.owner,
          // VERCEL is "1" on every target (preview/dev too), so gate the trace
          // environment on VERCEL_ENV to keep preview/dev traces out of prod.
          environment: process.env.VERCEL_ENV === "production" ? "production" : "development",
          waitUntil: process.env.VERCEL ? waitUntil : undefined,
          afterRun: async ({ meta, outcome }) => {
            if (outcome.status !== "completed") return;
            // Lazy import: judge-run pulls getLatch back (agent store + models).
            const { judgeLiveRun } = await import("./observability/judge-run");
            // Best-effort: on non-Vercel hosts this is awaited inline in the
            // run-finalization path, so a judge/persistence failure must never
            // propagate and break run completion.
            await judgeLiveRun({ meta, outcome }).catch((error) => {
              console.warn(`online judge failed (run ${meta.runId}):`, error);
            });
          },
        })
      : undefined,
  });

  // The connection registry the handler's OAuth/status/test routes see: code
  // connections, plus the UI-added ones dispatched by name. So `connect`,
  // authorize/callback, status, and test work for dynamic OAuth connections too.
  const handlerConnections: McpConnections<Principal> = {
    host: builtinConnections.host,
    hostFor: (names) => builtinConnections.hostFor(names),
    names: builtinConnections.names,
    oauth: (name) =>
      builtinConnections.names.includes(name)
        ? builtinConnections.oauth(name)
        : dynamic.oauth(name),
    status: async (p) => [
      ...(await builtinConnections.status(p)),
      ...(await dynamic.status(p)),
    ],
    testTools: (name, p) =>
      builtinConnections.names.includes(name)
        ? builtinConnections.testTools(name, p)
        : dynamic.testTools(name, p),
  };

  const handler = createLatchHandler<Principal>({
    runtime,
    connections: handlerConnections,
    basePath: "/api/latch",
    resolveContext: (request) => getPrincipalFromHeaders(request.headers),
    // Guards POST /api/latch/cron/run for an external cron in prod. That route is
    // NOT user-authed and fires every tenant's due schedules, so in production an
    // unset secret must leave this undefined — the handler then 404s the route
    // rather than guarding it with a constant published in this repo. Dev keeps a
    // convenient default. (Not `secretEnv`: throwing here would fail app boot for
    // every request, not just the cron route.)
    cronSecret:
      process.env.LATCH_CRON_SECRET ??
      (process.env.NODE_ENV === "production" ? undefined : "dev-cron-secret"),
  });

  // Dev only: no long-running process, so tick due schedules in-process every
  // 30s. In prod (Vercel), the platform cron hits `/api/cron` instead (which
  // also sweeps crashed runs), so skip this — serverless wouldn't run it
  // reliably anyway. Errors are swallowed — a bad tick never crashes dev.
  if (!process.env.VERCEL) {
    const tick = setInterval(() => {
      void runtime.runDue().catch((e) => console.warn("runDue failed:", e));
      // Reap lease-expired (crashed) runs — without this a dev-server restart
      // mid-turn leaves the run "running" forever and its chat shows an eternal
      // "Generating…" (reap only; no auto-resume in dev).
      void runtime.tick().catch((e) => console.warn("tick failed:", e));
    }, 30_000);
    (tick as { unref?: () => void }).unref?.();
    // Memory sweep on a slower cadence (extraction is idle-gated anyway).
    // Lazy import — sweep.ts imports this module back.
    const memTick = setInterval(() => {
      void import("./memory/sweep")
        .then((m) => m.memorySweep())
        .catch((e) => console.warn("memory sweep failed:", e));
    }, 5 * 60_000);
    (memTick as { unref?: () => void }).unref?.();
  }

  cached = {
    runtime,
    // The merged built-ins (MCP + google_workspace) — server fns like the
    // Connections page's status list read this, not the raw MCP set.
    connections: builtinConnections,
    credentials,
    connectionStore,
    dynamic,
    allConnections,
    agentStore,
    slackStore,
    telegramStore,
    whatsappStore,
    toolStore,
    authoredTools,
    evalStore,
    runScores,
    models: catalog.models,
    modelFor: catalog.modelFor,
    handler,
    memoryStore,
    memoryJobs,
    resolveUsers,
  };
  return cached;
}
