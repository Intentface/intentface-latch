import {
  createMCPClient,
  type MCPClient,
  type MCPTransport,
  type OAuthClientProvider,
} from "@ai-sdk/mcp";
import type { SecretResolver } from "@intentface/latch-core";
import type { FetchFunction } from "./oauth-fetch.js";

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

/** MCP tool annotations (sensitivity hints) the server may advertise. */
export interface McpToolInfo {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [k: string]: unknown;
  };
}

/**
 * Which of a connection's tools require human approval before running.
 * - `"destructive"` (default): respect MCP's built-in hints — gate any tool the
 *   server marks `destructiveHint: true` or explicitly `readOnlyHint: false`.
 * - `"all"` / `"none"`: gate every tool / no tool.
 * - a predicate: decide per tool from its annotations.
 */
export type McpApprovalPolicy =
  | "destructive"
  | "all"
  | "none"
  | ((tool: McpToolInfo) => boolean);

/** Apply an approval policy to one tool (defaults to `"destructive"`). */
export function needsMcpApproval(
  policy: McpApprovalPolicy | undefined,
  tool: McpToolInfo,
): boolean {
  const p = policy ?? "destructive";
  if (typeof p === "function") return p(tool);
  if (p === "all") return true;
  if (p === "none") return false;
  const a = tool.annotations ?? {};
  return a.destructiveHint === true || a.readOnlyHint === false;
}

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
      /**
       * Custom fetch for this connection's requests AND the transport's on-401
       * re-auth/refresh. Pass the same fetch used by the OAuth flow (e.g.
       * `createOAuthDiscoveryFetch`) so discovery normalization is consistent.
       */
      fetch?: FetchFunction;
      /** Which tools require approval (default: respect MCP destructive hints). */
      approval?: McpApprovalPolicy;
    }
  | {
      name: string;
      /** A prebuilt transport (stdio/in-memory/custom). Used as-is. */
      transport: MCPTransport;
      /** Which tools require approval (default: respect MCP destructive hints). */
      approval?: McpApprovalPolicy;
    };

export interface McpHostConfig<P> {
  /** Connections, static or resolved per caller (e.g. to inject OAuth providers). */
  connections:
    | McpConnection[]
    | ((principal: P) => McpConnection[] | Promise<McpConnection[]>);
  /**
   * SSRF allowlist of permitted hostnames. An entry beginning with `.` matches
   * that domain and its subdomains (`.example.com` → `example.com`,
   * `api.example.com`). Static, or resolved per caller.
   */
  allowedHosts: string[] | ((principal: P) => string[] | Promise<string[]>);
  /** Vault read-side, used for bearer auth. */
  secrets?: SecretResolver<P>;
  /** Observe a connection that failed to open (it's skipped, not fatal). */
  onConnectionError?: (name: string, error: unknown) => void;
}

export interface OpenMcp {
  /** Merged, name-prefixed tools, ready to spread into an agent's `tools`. */
  tools: Record<string, unknown>;
  /**
   * Per-tool approval policy derived from each connection's `approval` setting
   * and the MCP servers' tool annotations (`<name>_<tool>: "user-approval"`).
   * Merged into the agent's `toolApproval` by the runtime.
   */
  toolApproval: Record<string, unknown>;
  /** Close every underlying client. Call when the turn finishes. */
  close(): Promise<void>;
}

export interface McpHost<P> {
  open(principal: P): Promise<OpenMcp>;
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
export async function buildAuthHeaders<P>(
  conn: { name: string; auth?: McpAuth },
  principal: P,
  secrets?: SecretResolver<P>,
): Promise<Record<string, string>> {
  if (!conn.auth) return {};
  if (conn.auth.type === "headers") return { ...conn.auth.headers };
  // bearer
  if (!secrets) {
    throw new Error(
      `MCP connection "${conn.name}" needs bearer auth but no secrets resolver is configured`,
    );
  }
  const token = await secrets(principal, conn.auth.vaultKey);
  if (!token) {
    throw new Error(
      `MCP connection "${conn.name}": secret "${conn.auth.vaultKey}" not found for this tenant`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

export function createMcpHost<P>(config: McpHostConfig<P>): McpHost<P> {
  return {
    async open(principal) {
      const allowed =
        typeof config.allowedHosts === "function"
          ? await config.allowedHosts(principal)
          : config.allowedHosts;
      const connections =
        typeof config.connections === "function"
          ? await config.connections(principal)
          : config.connections;

      const clients: MCPClient[] = [];
      const tools: Record<string, unknown> = {};
      const toolApproval: Record<string, unknown> = {};
      const closeAll = () =>
        Promise.all(clients.map((c) => c.close().catch(() => {}))).then(
          () => undefined,
        );

      for (const conn of connections) {
        // SSRF guard is a HARD failure (security): an unlisted host throws,
        // before any socket opens.
        if (!("transport" in conn)) {
          const host = new URL(conn.url).hostname;
          if (!isHostAllowed(host, allowed)) {
            await closeAll();
            throw new Error(
              `MCP host not allowed for this tenant: ${host} (connection "${conn.name}")`,
            );
          }
        }
        // A connection that can't be opened (down / bad token / no tools) is
        // SKIPPED, not fatal — the agent degrades gracefully without it.
        try {
          let client: MCPClient;
          if ("transport" in conn) {
            client = await createMCPClient({
              transport: conn.transport,
            } as Parameters<typeof createMCPClient>[0]);
          } else {
            const headers = await buildAuthHeaders(conn, principal, config.secrets);
            client = await createMCPClient({
              transport: {
                type: "http",
                url: conn.url,
                headers,
                authProvider: conn.authProvider, // OAuth (auto-refresh) if present
                redirect: "error", // no redirect-based SSRF
                fetch: conn.fetch, // normalizing fetch for on-401 re-auth, if set
              },
            } as Parameters<typeof createMCPClient>[0]);
          }
          clients.push(client);
          // listTools (not tools()) so we keep the annotations the AI SDK's
          // tools() drops — they drive the approval policy. tools() is exactly
          // toolsFromDefinitions(listTools()), so this builds identical tools.
          const defs = await client.listTools();
          const serverTools = client.toolsFromDefinitions(defs);
          const annotations = new Map<string, McpToolInfo["annotations"]>(
            (defs.tools ?? []).map((t) => [t.name, t.annotations]),
          );
          for (const [name, tool] of Object.entries(serverTools)) {
            const key = `${conn.name}_${name}`; // namespace to avoid collisions
            tools[key] = tool;
            if (needsMcpApproval(conn.approval, { name, annotations: annotations.get(name) })) {
              toolApproval[key] = "user-approval";
            }
          }
        } catch (error) {
          config.onConnectionError?.(conn.name, error);
        }
      }

      return { tools, toolApproval, close: closeAll };
    },
  };
}
