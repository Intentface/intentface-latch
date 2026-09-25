import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  createIntervalScheduler,
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
  createSqliteAgentBuilderStore,
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
import { credentialPrincipalOf, getPrincipalFromHeaders } from "./session";
import type {Principal} from "./session";
import { createCredentials  } from "./credentials";
import type {Credentials} from "./credentials";
import { createNamedSecrets } from "./named-secrets";
import type { NamedSecrets } from "./named-secrets";
import { createConnectionStore  } from "./connection-store";
import type {ConnectionStore} from "./connection-store";
import { createDynamicConnections  } from "./dynamic-connections";
import type {DynamicConnections} from "./dynamic-connections";
import { agentOwnerKey, agentOwnerSegments, evalOwnerOfRecord, parseAgentRef } from "./agent-store";
import type { AgentStore } from "./agent-store";
import { memoryAgentOf } from "./memory/agent-identity";
import { isOrgMember } from "./auth";
import { createSlackStore, migrateSlack, slackVaultKeys } from "./slack-store";
import type {SlackStore} from "./slack-store";
import { createChannelStore, migrateChannels } from "./channel-store";
import { platformLimits } from "./limits";
import type { ChannelStore } from "./channel-store";
import { createToolStore, migrateAuthoredTools  } from "./tools/store";
import type {ToolStore} from "./tools/store";
import { createEvalStore, migrateEvals } from "./evals/store";
import { createEvalsStore, migrateEvalsV2, type EvalsStore } from "./evals/v2/store";
import type {EvalStore} from "./evals/store";
import { createRunScoresStore, migrateRunScores } from "./observability/run-scores-store";
import type {RunScoresStore} from "./observability/run-scores-store";
import type { UserProfile } from "./observability/runners";
import { createAuthoredTools  } from "./tools";
import type {AuthoredToolsApi} from "./tools";
import { baseUrl } from "./base-url";
import { loadModelCatalog, providerDefaults } from "@intentface/latch-core/models";
import type { ModelInfo } from "@intentface/latch-core/models";
import { createSandboxResolver, harnessTools } from "./sandbox";
import {
  createGoogleWorkspaceConnection,
  createGoogleWorkspaceWriteConnection,
} from "./google-workspace";
import { createCachingStats } from "./caching-stats";

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
      namedSecrets: NamedSecrets;
      connectionStore: ConnectionStore;
      dynamic: DynamicConnections;
      allConnections: ConnectionRegistry<Principal>;
      agentStore: AgentStore;
      slackStore: SlackStore;
      channelStore: ChannelStore;
      toolStore: ToolStore;
      authoredTools: AuthoredToolsApi;
      evalStore: EvalStore;
      evals: EvalsStore;
      runScores: RunScoresStore;
      models: ModelInfo[];
      modelFor: (id: string) => LanguageModel;
      /** USD per 1M tokens by model id — what an estimate on another model scales by. */
      pricing: (id: string) => { inputPer1M: number; outputPer1M: number } | undefined;
      /** Per-agent prompt-cache stats + lint for /caching. */
      cachingStats: ReturnType<typeof createCachingStats>;
      /** The adapter's serialized owner key for a principal (raw-SQL scoping). */
      ownerKeyFor: (p: Principal) => string;
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
  namedSecrets: NamedSecrets;
  connectionStore: ConnectionStore;
  dynamic: DynamicConnections;
  allConnections: ConnectionRegistry<Principal>;
  agentStore: AgentStore;
  slackStore: SlackStore;
  channelStore: ChannelStore;
  toolStore: ToolStore;
  authoredTools: AuthoredToolsApi;
  evalStore: EvalStore;
  evals: EvalsStore;
  runScores: RunScoresStore;
  models: ModelInfo[];
  modelFor: (id: string) => LanguageModel;
  pricing: (id: string) => { inputPer1M: number; outputPer1M: number } | undefined;
  cachingStats: ReturnType<typeof createCachingStats>;
  ownerKeyFor: (p: Principal) => string;
  handler: LatchHandler;
  memoryStore: MemoryStore<Principal>;
  memoryJobs: MemoryJobStore;
  resolveUsers: (userIds: string[]) => Promise<Map<string, UserProfile>>;
}> {
  if (cached) return cached;

  // Local dev → a file DB; prod → a hosted libsql (Turso) URL + auth token.
  const url = process.env.DATABASE_URL ?? "file:./latch.db";
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  // A local SQLite file defaults to the rollback journal and, worse, to
  // `busy_timeout = 0`: a second writer gets SQLITE_BUSY immediately instead of
  // waiting its turn. Any concurrent work then fails rather than queues, and a
  // durable runtime writes a checkpoint per step — so four agents in parallel
  // lost checkpoints, which is not a crash but a silently truncated transcript.
  //
  // WAL lets readers run while one writer commits; the timeout makes the second
  // writer wait rather than give up. Remote libsql handles its own concurrency,
  // so this applies only to a file.
  if (url.startsWith("file:")) {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 10000");
    // NORMAL is the recommended pairing with WAL: durable across process
    // crashes, and does not fsync on every single commit.
    await client.execute("PRAGMA synchronous = NORMAL");
  }
  await migrate(client); // creates latch_* tables (incl. latch_agents) alongside the auth tables
  await migrateSlack(client); // latch_slack_app + latch_slack_thread (Slack-only state)
  await migrateChannels(client); // shared channel tables (bots, identities, pendings, dedupe, turn/ask/thread) + legacy carry-over
  await migrateAuthoredTools(client); // latch_tools (authored, sandboxed fetch+compute tools)
  await migrateEvals(client); // latch_eval_sets + latch_eval_runs (agent eval loop)
  await migrateEvalsV2(client); // datasets, inputs, rubrics, threads, verdicts, rulings (evals v2)
  await migrateRunScores(client); // latch_run_scores (fast local mirror for the chat evals panel)

  // The ownership key — the isolation boundary. With a userId it's per-user
  // (`[org,user]`); a userId-stripped principal yields the org-shared owner
  // (`[org]`) — used for org-level credentials.
  const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);
  // The serialized form the drizzle adapter stores in owner columns is the
  // same derivation as `ownerTagOf` — raw-SQL stores (caching stats) and
  // per-principal cache keys reuse it so all three can never drift apart.
  const ownerKeyStr = ownerTagOf;

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
  const namedSecrets = createNamedSecrets(vault);
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
  // UI-created agents (latch_agents, org/personal) — the framework's record +
  // drizzle store; the platform supplies only its owner-key policy. Agents may
  // attach authored tools, resolved per caller at turn time: an org agent
  // resolves only org tools (so every member gets them); a personal agent
  // merges org + personal.
  const agentStore: AgentStore = createSqliteAgentBuilderStore<Principal>(db, {
    owner: agentOwnerSegments,
    modelFor: catalog.modelFor,
    loadAuthoredTools: (p, names, scope) => authoredTools.executableTools(p, names, scope),
  });
  const slackStore = createSlackStore(client);
  const channelStore = createChannelStore(client);
  // Eval sets + persisted runs for the Agent Builder's evaluate→improve loop.
  const evalStore = createEvalStore(client);
  const evals = createEvalsStore(client);
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

  /**
   * Make room for `incoming` new entries: sweep TTL-expired ones, then evict from
   * the front until under the cap. Called ONCE per batch rather than per row — it
   * scans the whole map, so calling it inside the insert loop was quadratic.
   */
  function boundUserCache(incoming: number) {
    if (userCache.size + incoming <= USER_CACHE_MAX) return;
    // Bound the cache: TTL alone never evicts users that stop being queried.
    // Sweep expired entries first; if every entry is still live, drop from the
    // front (Map preserves insertion order, and `cacheUser` re-inserts on
    // refresh, so the front is the least-recently-refreshed).
    const now = Date.now();
    for (const [k, v] of userCache) if (now - v.at >= USER_TTL_MS) userCache.delete(k);
    while (userCache.size + incoming > USER_CACHE_MAX) {
      const oldest = userCache.keys().next().value;
      if (oldest === undefined) break;
      userCache.delete(oldest);
    }
  }

  /**
   * Cache one profile, keeping the map's iteration order approximately LRU: a
   * plain `set` on an existing key leaves it where it was, so a hot user would
   * stay at the front and be evicted first even right after a refresh.
   */
  function cacheUser(id: string, value: UserProfile | undefined) {
    userCache.delete(id);
    userCache.set(id, { at: Date.now(), value });
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
      boundUserCache(missing.length);
      const found = new Set<string>();
      for (const row of res.rows as unknown as Record<string, unknown>[]) {
        const id = String(row.id);
        const value: UserProfile = {
          name: (row.name as string) || undefined,
          email: (row.email as string) || undefined,
        };
        found.add(id);
        cacheUser(id, value);
        out.set(id, value);
      }
      // Cache the misses too, so an unknown id doesn't re-query every poll.
      for (const id of missing) {
        if (!found.has(id)) cacheUser(id, undefined);
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
    secrets: namedSecrets,
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
    // `memoryAgentOf`: a channel binding's `org:`/`user:` pin must not fork the
    // scope — a Telegram turn and a web turn are the same agent's memory.
    scopeOf: ({ principal, agent, memory }) =>
      scopeRefOf({ agent: memoryAgentOf(agent), memory, userId: principal.userId }),
    // Retention signal: recalled ids bump usage (expiry works off this).
    recordUsage: (scopeKey, ids) => memoryJobs.recordUsage(scopeKey, ids, Date.now()),
    // A memory_save episode marks the scope dirty for the next consolidation,
    // stamping the caller so the job can run under the scope's own principal.
    onEpisodeWritten: ({ scopeKey, connection, agent, principal, path }) =>
      memoryJobs.touchScope(
        {
          scopeKey,
          owner: ownerTagOf(principal),
          // Bare, like the scope it belongs to: the sweep looks this agent's
          // memory config up when it consolidates the row.
          agent: memoryAgentOf(agent),
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
    // UI-created agents (not in the static `agents` registry) — and eval
    // variants of them: `name[@base]~id` is that base with one thing changed
    // (model, reasoning effort, an added instruction line), never saved as a
    // version. Only evals run them.
    dynamicAgents: {
      list: (p) => agentStore.list(p),
      resolve: async (name, p) => {
        const cut = name.indexOf("~");
        if (cut < 0) return agentStore.resolve(name, p);
        const base = name.slice(0, cut);
        const cfg = await agentStore.resolve(base, p);
        const rec = await agentStore.getRecord(p, parseAgentRef(base).name);
        if (!cfg || !rec) return undefined;
        const v = await evals.getVariant(agentOwnerKey(p, rec.scope), name.slice(cut + 1));
        if (!v) return undefined;
        const add = v.change.addInstructions?.trim();
        return {
          ...cfg,
          ...(v.change.model ? { model: catalog.modelFor(v.change.model) } : {}),
          ...(v.change.effort ? { effort: v.change.effort } : {}),
          ...(add ? { instructions: `${cfg.instructions ?? ""}\n\n${add}` } : {}),
        };
      },
    },
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
    // A schedule carrying a delivery target runs IN its channel conversation
    // (the user's Telegram DM, a Slack thread) instead of a fresh chat, so the
    // report lands where they'll read it. Returns false for a target that's
    // absent or no longer authorized → core runs the fire the ordinary way.
    // Imported lazily: this module reaches back into `getLatch()`.
    runSchedule: async (input) => {
      // Fire-time identity re-validation first: a departed member's schedule
      // is REMOVED instead of firing forever under a stale principal.
      const sd = await import("./schedule-delivery");
      if (await sd.removeIfActorDeparted(input, (args) => runtime.unschedule(args)))
        return true; // handled → fire suppressed, occurrence already consumed
      return sd.runScheduledDelivery(input);
    },
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
    // The provider-specific hooks, from the catalog: pricing (USD/1M from
    // models.dev), native provider web tools, reasoning effort → provider
    // options, and prompt caching (Anthropic breakpoints, OpenAI routing key
    // scoped per principal for memory-enabled agents). LATCH_PROMPT_CACHING=0
    // turns caching off platform-wide (the control arm of an A/B).
    ...providerDefaults<Principal, Ctx>(catalog, {
      principalKey: ownerKeyStr,
      promptCaching: process.env.LATCH_PROMPT_CACHING !== "0",
    }),
    // Per org / user / agent budgets (opt-in via LATCH_LIMIT_* env, see
    // lib/limits.ts): 429 at admission, tool loop stopped at the token budget.
    limits: platformLimits(db),
    // Langfuse observability (opt-in via LANGFUSE_* env): every run becomes a
    // trace tagged owner/agent/run; attached-eval judges + user feedback land
    // on it as scores. Absent keys → undefined → zero behavior change.
    telemetry: isLangfuseConfigured()
      ? langfuseTelemetry<Principal>({
          ownerTag: ownerTagOf,
          // Tag the trace with the AGENT's owner so /observability can show a
          // colleague's runs on the agents this reader administers. Undefined for
          // code-registry agents (no row) — the tag is simply omitted.
          agentOwnerTag: async (run) => {
            const rec = await agentStore.getRecord(run.principal, run.agent);
            return rec ? evalOwnerOfRecord(run.principal, rec) : undefined;
          },
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

  // Slack connect flow: a sign-in card in a thread points the browser at the
  // generic connections authorize route with `slackApp=<appId>`. The grant must
  // land under the principal the SLACK TURN checks — the app binding's — not
  // the browser session's, or signing in never satisfies the card that asked
  // for it (the tokens and the flow's code verifier both live per-owner-key).
  // Scoped HARD to the authorize route: anywhere else a `?slackApp=` param
  // must not let a member read another principal's chats. Membership in the
  // binding's org is required — the same gate that lets them drive the bot.
  // The binding principal produced here is what the handler PINS into the
  // flow state; the callback rebuilds it from that pin (reconstructOAuth-
  // Principal below) and never consults the session again.
  const CONNECT_AUTHORIZE_ROUTE = /^\/api\/latch\/connections\/[^/]+\/authorize$/;
  const resolveContext = async (request: Request): Promise<Principal | null> => {
    const session = await getPrincipalFromHeaders(request.headers);
    const url = new URL(request.url);
    const slackApp = CONNECT_AUTHORIZE_ROUTE.test(url.pathname)
      ? url.searchParams.get("slackApp")
      : null;
    if (!slackApp) return session;
    if (!session?.userId) return null;
    const app = await slackStore.resolve(slackApp);
    if (!app) return null;
    if (!(await isOrgMember(session.userId, app.orgId))) return null;
    // Binding principal for chat/flow state, the CLICKER as the actor: the
    // grant then lands under their credential key (credentialPrincipalOf in
    // the oauth dispatcher), which is what the per-user Slack turn checks —
    // one member's sign-in never satisfies (or pollutes) another's. A 'shared'
    // binding drops the actor — the grant lands on the binding key everyone
    // uses — which is exactly why only the BINDING CREATOR may run its
    // connect flow: org membership alone would let any member inject THEIR
    // account as the credentials the whole bot acts through.
    if (app.credentialMode === "shared") {
      if (!app.userId || session.userId !== app.userId) return null;
      return { orgId: app.orgId, userId: app.userId };
    }
    return { orgId: app.orgId, userId: app.userId, actorUserId: session.userId };
  };

  // OAuth-callback identity: the handler rebuilds the principal from the pin
  // baked into the flow state at authorize time — the live session at redirect
  // time never decides where credentials land (a session with no active org
  // once stored org-connection tokens under the personal owner). Validate the
  // shape and re-check that the acting human is still an org member; every
  // gate that produced the pinned principal (slackApp binding, shared-mode
  // creator-only) already ran at authorize time.
  const reconstructOAuthPrincipal = async (
    identity: unknown,
  ): Promise<Principal | null> => {
    if (typeof identity !== "object" || identity === null) return null;
    const p = identity as Partial<Principal>;
    if (typeof p.orgId !== "string" || !p.orgId) return null;
    if (p.userId !== undefined && typeof p.userId !== "string") return null;
    if (p.actorUserId !== undefined && typeof p.actorUserId !== "string") return null;
    const principal: Principal = {
      orgId: p.orgId,
      ...(p.userId ? { userId: p.userId } : {}),
      ...(p.actorUserId ? { actorUserId: p.actorUserId } : {}),
    };
    // Flows are always started by a human — an identity with no acting user
    // is malformed, not an org-level flow.
    const actor = credentialPrincipalOf(principal).userId;
    if (!actor) return null;
    if (!(await isOrgMember(actor, principal.orgId))) return null;
    return principal;
  };

  const handler = createLatchHandler<Principal>({
    runtime,
    connections: handlerConnections,
    basePath: "/api/latch",
    resolveContext,
    reconstructPrincipal: reconstructOAuthPrincipal,
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

  // Dev only: no long-running process, so run the cron in-process every 30s
  // — the same `runtime.cron()` the prod `/api/cron` route calls (due
  // schedules fired; lease-expired runs from a dev-server restart mid-turn
  // reaped and resumed, so a chat never shows an eternal "Generating…"). In
  // prod (Vercel) the platform cron hits the route instead; serverless
  // wouldn't run an interval reliably anyway. The interval scheduler never
  // overlaps ticks and unrefs its timer; a failing tick never crashes dev.
  if (!process.env.VERCEL) {
    createIntervalScheduler({
      intervalMs: 30_000,
      onTick: async () => {
        const r = await runtime.cron();
        if (r.errors.length) console.warn("cron phase failed:", r.errors);
      },
      onError: (e) => console.warn("cron failed:", e),
    }).start();
    // Memory sweep on a slower cadence (extraction is idle-gated anyway).
    // Lazy import — sweep.ts imports this module back.
    createIntervalScheduler({
      intervalMs: 5 * 60_000,
      onTick: async () => {
        const m = await import("./memory/sweep");
        await m.memorySweep();
      },
      onError: (e) => console.warn("memory sweep failed:", e),
    }).start();
    // Eval runs interrupted by a dev-server restart. Lazy import — evals-jobs imports this module back.
    createIntervalScheduler({
      intervalMs: 30_000,
      onTick: async () => {
        const m = await import("./evals-jobs");
        await m.evalJobsTick();
      },
      onError: (e) => console.warn("eval jobs tick failed:", e),
    }).start();
  }

  cached = {
    runtime,
    // The merged built-ins (MCP + google_workspace) — server fns like the
    // Connections page's status list read this, not the raw MCP set.
    connections: builtinConnections,
    credentials,
    namedSecrets,
    connectionStore,
    dynamic,
    allConnections,
    agentStore,
    slackStore,
    channelStore,
    toolStore,
    authoredTools,
    evalStore,
    evals,
    runScores,
    models: catalog.models,
    modelFor: catalog.modelFor,
    pricing: catalog.pricing,
    cachingStats: createCachingStats({ client, pricing: catalog.pricing }),
    ownerKeyFor: ownerKeyStr,
    handler,
    memoryStore,
    memoryJobs,
    resolveUsers,
  };
  return cached;
}
