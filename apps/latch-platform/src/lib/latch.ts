import { createClient } from "@libsql/client";
import {
  createRuntime,
  createVault,
  defineContext,
  mergeConnections,
  type Runtime,
  type ConnectionRegistry,
} from "@intentface/latch-core";
import {
  createSqliteAdapter,
  createSqliteSecretStore,
  migrate,
} from "@intentface/latch-drizzle";
import { createMcpConnections, type McpConnections } from "@intentface/latch-mcp";
import { createLatchHandler, type LatchHandler } from "@intentface/latch-server";
import { Cron } from "croner";
import { connectionDefs } from "@/connections";
import { agents } from "@/agents";
import { getPrincipalFromHeaders, type Principal } from "./session";
import { createCredentials, type Credentials } from "./credentials";
import { createConnectionStore, type ConnectionStore } from "./connection-store";
import { createDynamicConnections, type DynamicConnections } from "./dynamic-connections";
import { createAgentStore, migrateAgents, type AgentStore } from "./agent-store";
import { createSlackStore, migrateSlack, type SlackStore } from "./slack-store";
import { loadModelCatalog, type ModelInfo } from "./models";
import { resolveSandbox, harnessTools } from "./sandbox";

/** Our typed runtime context (built per turn from the principal). */
interface Ctx {
  orgId: string;
}

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
      models: ModelInfo[];
      handler: LatchHandler;
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
  models: ModelInfo[];
  handler: LatchHandler;
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

  // The ownership key — the isolation boundary. With a userId it's per-user
  // (`[org,user]`); a userId-stripped principal yields the org-shared owner
  // (`[org]`) — used for org-level credentials.
  const owner = (p: Principal) => (p.userId ? [p.orgId, p.userId] : [p.orgId]);

  const storage = createSqliteAdapter<Principal>(client, { owner });
  const vault = createVault<Principal>({
    store: createSqliteSecretStore<Principal>(client, { owner }),
    // Dev fallback is a deterministic 32-byte key; set LATCH_VAULT_KEY in prod.
    masterKey: process.env.LATCH_VAULT_KEY ?? btoa("latch-dev-vault-key-32-bytes!!!!"),
  });
  const credentials = createCredentials(vault);
  const connectionStore = createConnectionStore(vault);
  // Model catalog + pricing from models.dev (filtered to Anthropic).
  const catalog = await loadModelCatalog();
  // UI-created agents (latch_agents table, org/personal).
  const agentStore = createAgentStore(client, catalog.modelFor);
  const slackStore = createSlackStore(client);

  const context = defineContext<Principal, Ctx>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  // MCP connections, declared in `connections/`. SSRF allowlist derives from the
  // connection URLs; the OAuth callback base must match the mounted handler.
  // Resolve the public origin like auth.ts: explicit override → better-auth URL
  // → Vercel's prod domain → localhost. (Without this, OAuth callbacks pointed
  // at localhost in production.)
  const baseURL =
    process.env.PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000");
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

  // The full connection registry across kinds — also used to enumerate a
  // connection's tools for the agent editor.
  const allConnections = mergeConnections(connections, dynamic);

  const runtime = createRuntime<Principal, Ctx>({
    storage,
    context,
    agents,
    // Resolve each agent's `connections: [...]` across code-declared MCP +
    // OpenAPI and the UI-added (Vault-stored) connections.
    connections: allConnections,
    // UI-created agents (not in the static `agents` registry).
    dynamicAgents: agentStore,
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
    // is the zero-infra default; Daytona (opt-in) needs DAYTONA_API_KEY.
    sandbox: resolveSandbox,
    harnessTools,
  });

  // The connection registry the handler's OAuth/status/test routes see: code
  // connections, plus the UI-added ones dispatched by name. So `connect`,
  // authorize/callback, status, and test work for dynamic OAuth connections too.
  const handlerConnections: McpConnections<Principal> = {
    host: connections.host,
    hostFor: (names) => connections.hostFor(names),
    names: connections.names,
    oauth: (name) =>
      connections.names.includes(name) ? connections.oauth(name) : dynamic.oauth(name),
    status: async (p) => [...(await connections.status(p)), ...(await dynamic.status(p))],
    testTools: (name, p) =>
      connections.names.includes(name)
        ? connections.testTools(name, p)
        : dynamic.testTools(name, p),
  };

  const handler = createLatchHandler<Principal>({
    runtime,
    connections: handlerConnections,
    basePath: "/api/latch",
    resolveContext: (request) => getPrincipalFromHeaders(request.headers),
    // Guards POST /api/latch/cron/run for an external cron in prod.
    cronSecret: process.env.LATCH_CRON_SECRET ?? "dev-cron-secret",
  });

  // Dev only: no long-running process, so tick due schedules in-process every
  // 30s. In prod (Vercel), the platform cron hits `/api/cron` instead (which
  // also sweeps crashed runs), so skip this — serverless wouldn't run it
  // reliably anyway. Errors are swallowed — a bad tick never crashes dev.
  if (!process.env.VERCEL) {
    const tick = setInterval(() => {
      void runtime.runDue().catch((e) => console.warn("runDue failed:", e));
    }, 30_000);
    (tick as { unref?: () => void }).unref?.();
  }

  cached = {
    runtime,
    connections,
    credentials,
    connectionStore,
    dynamic,
    allConnections,
    agentStore,
    slackStore,
    models: catalog.models,
    handler,
  };
  return cached;
}
