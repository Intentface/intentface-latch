import {
  createMCPClient,
  type MCPClient,
  type MCPTransport,
  type OAuthClientProvider,
} from "@ai-sdk/mcp";
import type { Scope, SecretResolver } from "@intentface/latch-core";

/**
 * The MCP host — connect to MCP servers and expose their tools to an agent,
 * with two Latch-specific guards on top of the SDK client:
 *
 *  1. A per-tenant SSRF allowlist: a connection's host must be explicitly
 *     permitted before we open a socket to it (and the transport rejects
 *     redirects, so a server can't bounce us somewhere else).
 *  2. Vault-brokered auth: bearer tokens are resolved per-tenant from the Vault
 *     and injected as request headers — they never appear in agent config.
 */

export type McpAuth =
  | { type: "bearer"; vaultKey: string }
  | { type: "headers"; headers: Record<string, string> };

/**
 * A connection is either a URL (untrusted/config-driven → SSRF allowlist + auth
 * applies) or a developer-provided transport instance (trusted in-process; e.g.
 * stdio or an in-memory transport — no allowlist, it carries its own auth).
 */
export type McpConnection =
  | {
      /** Namespacing prefix for this server's tools (e.g. `linear` → `linear_*`). */
      name: string;
      /** MCP server URL (HTTP transport). */
      url: string;
      /** Static/bearer auth. Bearer tokens come from the Vault, per tenant. */
      auth?: McpAuth;
      /** OAuth provider (auto-refreshing). Build per scope via `McpOAuth.provider(scope)`. */
      authProvider?: OAuthClientProvider;
    }
  | {
      name: string;
      /** A prebuilt transport (stdio/in-memory/custom). Used as-is. */
      transport: MCPTransport;
    };

export interface McpHostConfig {
  /** Connections, static or resolved per tenant (e.g. to inject OAuth providers). */
  connections:
    | McpConnection[]
    | ((scope: Scope) => McpConnection[] | Promise<McpConnection[]>);
  /**
   * SSRF allowlist of permitted hostnames. An entry beginning with `.` matches
   * that domain and its subdomains (`.example.com` → `example.com`,
   * `api.example.com`). Static, or resolved per tenant.
   */
  allowedHosts: string[] | ((scope: Scope) => string[] | Promise<string[]>);
  /** Vault read-side, used for bearer auth. */
  secrets?: SecretResolver;
}

export interface OpenMcp {
  /** Merged, name-prefixed tools, ready to spread into an agent's `tools`. */
  tools: Record<string, unknown>;
  /** Close every underlying client. Call when the turn finishes. */
  close(): Promise<void>;
}

export interface McpHost {
  open(scope: Scope): Promise<OpenMcp>;
}

/** True if `host` is permitted by the allowlist (exact, or `.suffix` subdomain). */
export function isHostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    if (a.startsWith(".")) return h === a.slice(1) || h.endsWith(a);
    return h === a;
  });
}

/**
 * Resolve the request headers for a connection. Bearer tokens are read from the
 * Vault per tenant; the token is returned for immediate egress use and is never
 * logged or persisted by the host.
 */
export async function buildAuthHeaders(
  conn: { name: string; auth?: McpAuth },
  scope: Scope,
  secrets?: SecretResolver,
): Promise<Record<string, string>> {
  if (!conn.auth) return {};
  if (conn.auth.type === "headers") return { ...conn.auth.headers };
  // bearer
  if (!secrets) {
    throw new Error(
      `MCP connection "${conn.name}" needs bearer auth but no secrets resolver is configured`,
    );
  }
  const token = await secrets(scope, conn.auth.vaultKey);
  if (!token) {
    throw new Error(
      `MCP connection "${conn.name}": secret "${conn.auth.vaultKey}" not found for this tenant`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

export function createMcpHost(config: McpHostConfig): McpHost {
  return {
    async open(scope) {
      const allowed =
        typeof config.allowedHosts === "function"
          ? await config.allowedHosts(scope)
          : config.allowedHosts;
      const connections =
        typeof config.connections === "function"
          ? await config.connections(scope)
          : config.connections;

      const clients: MCPClient[] = [];
      const tools: Record<string, unknown> = {};
      const closeAll = () =>
        Promise.all(clients.map((c) => c.close().catch(() => {}))).then(
          () => undefined,
        );

      try {
        for (const conn of connections) {
          let client: MCPClient;
          if ("transport" in conn) {
            // Developer-provided transport (in-process; trusted): use as-is.
            client = await createMCPClient({
              transport: conn.transport,
            } as Parameters<typeof createMCPClient>[0]);
          } else {
            // SSRF guard: refuse to connect to a host this tenant isn't allowed.
            const host = new URL(conn.url).hostname;
            if (!isHostAllowed(host, allowed)) {
              throw new Error(
                `MCP host not allowed for this tenant: ${host} (connection "${conn.name}")`,
              );
            }
            const headers = await buildAuthHeaders(conn, scope, config.secrets);
            client = await createMCPClient({
              transport: {
                type: "http",
                url: conn.url,
                headers,
                authProvider: conn.authProvider, // OAuth (auto-refresh) if present
                redirect: "error", // no redirect-based SSRF
              },
            } as Parameters<typeof createMCPClient>[0]);
          }
          clients.push(client);

          const serverTools = await client.tools();
          for (const [name, tool] of Object.entries(serverTools)) {
            tools[`${conn.name}_${name}`] = tool; // namespace to avoid collisions
          }
        }
      } catch (error) {
        await closeAll(); // don't leak half-open clients on failure
        throw error;
      }

      return { tools, close: closeAll };
    },
  };
}
