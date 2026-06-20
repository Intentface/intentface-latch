import { createClient } from "@libsql/client";
import {
  createRuntime,
  createVault,
  defineContext,
  mergeConnections,
  staticPricing,
  type Runtime,
} from "@intentface/latch-core";
import {
  createSqliteAdapter,
  createSqliteSecretStore,
  migrate,
} from "@intentface/latch-drizzle";
import { createMcpConnections, type McpConnections } from "@intentface/latch-mcp";
import { createOpenApiConnections, apiKey } from "@intentface/latch-openapi";
import { createLatchHandler, type LatchHandler } from "@intentface/latch-server";
import { Cron } from "croner";
import { connectionDefs } from "@/connections";
import { clockify, clockifyScope, clockifyHosts } from "@/connections/clockify";
import { agents } from "@/agents";
import { getPrincipalFromHeaders, type Principal } from "./session";
import { createCredentials, type Credentials } from "./credentials";

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
      handler: LatchHandler;
    }
  | undefined;

export async function getLatch(): Promise<{
  runtime: Runtime<Principal>;
  connections: McpConnections<Principal>;
  credentials: Credentials;
  handler: LatchHandler;
}> {
  if (cached) return cached;

  const client = createClient({ url: process.env.DATABASE_URL ?? "file:./latch.db" });
  await migrate(client); // creates latch_* tables alongside the auth tables

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

  const context = defineContext<Principal, Ctx>({
    build: ({ principal }) => ({ orgId: principal.orgId }),
  });

  // MCP connections, declared in `connections/`. SSRF allowlist derives from the
  // connection URLs; the OAuth callback base must match the mounted handler.
  const baseURL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  const allowedHosts = Object.values(connectionDefs).map((c) => new URL(c.url).hostname);

  const connections = createMcpConnections<Principal>({
    vault,
    secrets: vault.resolver,
    allowedHosts,
    connections: connectionDefs,
    callbackBaseUrl: `${baseURL}/api/latch/connections`,
    onConnectionError: (name, err) =>
      console.warn(`MCP "${name}" skipped:`, err instanceof Error ? err.message : err),
  });

  // OpenAPI connections (REST APIs with no MCP server). Clockify's key is
  // org-scoped, read from the Vault (env is a zero-config dev fallback) — it's
  // brokered server-side and never reaches the model.
  const openapi = createOpenApiConnections<Principal>({
    allowedHosts: clockifyHosts,
    connections: {
      clockify: clockify(
        apiKey({
          header: "X-Api-Key",
          getKey: async (p) =>
            (await credentials.get(p, "clockify", clockifyScope)) ??
            process.env.CLOCKIFY_API_KEY,
        }),
      ),
    },
    onConnectionError: (name, err) =>
      console.warn(`OpenAPI "${name}" skipped:`, err instanceof Error ? err.message : err),
  });

  const runtime = createRuntime<Principal, Ctx>({
    storage,
    context,
    agents,
    // Resolve each agent's `connections: [...]` across MCP + OpenAPI.
    connections: mergeConnections(connections, openapi),
    // Resume/cron: the run stored our Principal verbatim; pass it back as-is.
    reconstructPrincipal: (identity) => identity as Principal,
    durability: { enabled: true, leaseTtlMs: 30_000, heartbeatMs: 10_000 },
    // Cron evaluator for scheduled agents (croner). Interpreted in UTC so fire
    // times are deterministic regardless of the host's timezone.
    cron: (expr, afterMs) =>
      new Cron(expr, { timezone: "UTC" }).nextRun(new Date(afterMs))?.getTime() ?? null,
    // Illustrative rates (USD per 1M tokens). Swap for models.dev later.
    pricing: staticPricing({
      "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
    }),
  });

  const handler = createLatchHandler<Principal>({
    runtime,
    connections,
    basePath: "/api/latch",
    resolveContext: (request) => getPrincipalFromHeaders(request.headers),
    // Guards POST /api/latch/cron/run for an external cron in prod.
    cronSecret: process.env.LATCH_CRON_SECRET ?? "dev-cron-secret",
  });

  // Dev: no long-running process, so tick due schedules in-process every 30s.
  // In prod, point a platform cron (Vercel Cron, etc.) at /api/latch/cron/run
  // instead and drop this. Errors are swallowed — a bad tick never crashes dev.
  const tick = setInterval(() => {
    void runtime.runDue().catch((e) => console.warn("runDue failed:", e));
  }, 30_000);
  (tick as { unref?: () => void }).unref?.();

  cached = { runtime, connections, credentials, handler };
  return cached;
}
