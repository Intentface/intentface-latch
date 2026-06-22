import { tool, jsonSchema } from "ai";
import type {
  ConnectionRegistry,
  OpenToolSet,
  ToolSource,
  Vault,
} from "@intentface/latch-core";
import {
  createMcpHost,
  createMcpOAuth,
  type McpAuth,
  type McpOAuth,
  type ConnectionStatus,
} from "@intentface/latch-mcp";
import {
  createOpenApiConnections,
  defineOpenApiConnection,
  headers as openApiHeaders,
  type OpenApiAuth,
} from "@intentface/latch-openapi";
import type { Principal } from "./session";
import type { ConnectionStore, StoredConnection } from "./connection-store";

/**
 * A ConnectionRegistry backed by the Vault-stored connections (added via UI).
 * `hostFor(names)` resolves an agent's declared names against the caller's
 * in-scope connections (org-shared + personal) at turn time and builds their
 * tools — MCP or OpenAPI — with the token brokered server-side. Names not found
 * in scope are simply absent (the agent degrades gracefully).
 *
 * MCP connections can authenticate three ways: a static `bearer`/`header` token,
 * or interactive `oauth` (no stored secret — the per-user tokens come from the
 * browser flow). OAuth connections expose a gated `connect_<name>` tool so the
 * agent can ask the user to authorize mid-chat, exactly like code-declared ones.
 * The registry therefore also surfaces the handler's connection routes
 * (`oauth`/`status`/`testTools`) for those UI connections.
 */
const hostOf = (u: string) => new URL(u).hostname;

/** Static token auth → MCP request headers (oauth carries no static secret). */
function mcpAuth(auth: StoredConnection["auth"]): McpAuth | undefined {
  if (!auth || auth.kind === "oauth") return undefined;
  const headers =
    auth.kind === "bearer"
      ? { Authorization: `Bearer ${auth.token}` }
      : { [auth.header ?? "Authorization"]: auth.token };
  return { type: "headers", headers };
}

/** Static token auth → OpenAPI header resolver (static). */
function openApiAuth(auth: StoredConnection["auth"]): OpenApiAuth<Principal> | undefined {
  if (!auth || auth.kind === "oauth") return undefined;
  return openApiHeaders(
    auth.kind === "bearer"
      ? { Authorization: `Bearer ${auth.token}` }
      : { [auth.header ?? "Authorization"]: auth.token },
  );
}

/** The synthetic, approval-gated tool that asks the user to authorize a connection. */
function connectTool(name: string) {
  return tool({
    description:
      `Connect the "${name}" integration. The user must authorize access first — ` +
      `calling this prompts them to connect. Only call it when ${name}'s own ` +
      `tools are not already available.`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => ({ connected: true, connection: name }),
  });
}

/** A dynamic registry plus the OAuth/status/test surface the handler needs. */
export interface DynamicConnections extends ConnectionRegistry<Principal> {
  /** The OAuth flow for a UI-added connection (always returns one; only meaningful for oauth MCP). */
  oauth(name: string): McpOAuth<Principal>;
  /** Status of the caller's UI-added MCP connections (oauth + authorized). */
  status(principal: Principal): Promise<ConnectionStatus[]>;
  /** Open one connection and list its namespaced tool names (a connectivity probe). */
  testTools(name: string, principal: Principal): Promise<string[]>;
}

export function createDynamicConnections(opts: {
  store: ConnectionStore;
  vault: Vault<Principal>;
  /** Base the OAuth callback lands on, e.g. `https://app/api/latch/connections`. */
  callbackBaseUrl: string;
  onConnectionError?: (name: string, error: unknown) => void;
}): DynamicConnections {
  const { store, vault, onConnectionError } = opts;
  const callbackBase = opts.callbackBaseUrl.replace(/\/$/, "");

  // Cache the OpenAPI registry per (name+spec+baseUrl) so the spec is fetched
  // and dereferenced once, not every turn.
  const openapiCache = new Map<
    string,
    ReturnType<typeof createOpenApiConnections<Principal>>
  >();

  // One McpOAuth per name. The server URL is resolved at flow time from the
  // caller's stored connection (it lives in their Vault scope) — see the lazy
  // `serverUrl` resolver, which is why this can be built without a principal.
  const oauthCache = new Map<string, McpOAuth<Principal>>();
  function oauthFor(name: string): McpOAuth<Principal> {
    let o = oauthCache.get(name);
    if (!o) {
      const redirectUrl = `${callbackBase}/${name}/callback`;
      o = createMcpOAuth<Principal>({
        vault,
        config: {
          name,
          serverUrl: async (p) => {
            const conn = await store.get(p, name);
            if (!conn || conn.kind !== "mcp" || !conn.mcp) {
              throw new Error(`Not an MCP connection: ${name}`);
            }
            // Don't run the flow (or strand tokens) for a connection that isn't
            // configured for OAuth — resolved before any auth request is made.
            if (conn.auth?.kind !== "oauth") {
              throw new Error(`Connection "${name}" is not configured for OAuth`);
            }
            return conn.mcp.url;
          },
          redirectUrl,
          clientMetadata: {
            client_name: `Latch (${name})`,
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
        },
      });
      oauthCache.set(name, o);
    }
    return o;
  }

  function openapiSource(conn: StoredConnection): ToolSource<Principal> {
    const o = conn.openapi!;
    const sig = `${conn.name}:${o.spec}:${o.baseUrl ?? ""}`;
    let reg = openapiCache.get(sig);
    if (!reg) {
      const hosts = [hostOf(o.spec), ...(o.baseUrl ? [hostOf(o.baseUrl)] : [])];
      reg = createOpenApiConnections<Principal>({
        allowedHosts: hosts,
        connections: {
          [conn.name]: defineOpenApiConnection<Principal>({
            spec: o.spec,
            baseUrl: o.baseUrl,
            operations: o.operations ? { allow: o.operations } : undefined,
            auth: openApiAuth(conn.auth),
          }),
        },
        onConnectionError,
      });
      openapiCache.set(sig, reg);
    }
    return reg.hostFor([conn.name]);
  }

  /** Open a static-token (or no-auth) MCP connection's live tools. */
  function mcpTokenSource(conn: StoredConnection): ToolSource<Principal> {
    const url = conn.mcp!.url;
    return createMcpHost<Principal>({
      allowedHosts: [hostOf(url)],
      onConnectionError,
      connections: [{ name: conn.name, url, auth: mcpAuth(conn.auth) }],
    });
  }

  /** Open an authorized OAuth MCP connection's live tools (auto-refreshing). */
  function mcpOAuthSource(conn: StoredConnection): ToolSource<Principal> {
    const url = conn.mcp!.url;
    return {
      async open(principal): Promise<OpenToolSet> {
        const o = oauthFor(conn.name);
        if (!(await o.isAuthorized(principal))) {
          return { tools: {}, toolApproval: {}, close: async () => {} };
        }
        return createMcpHost<Principal>({
          allowedHosts: [hostOf(url)],
          onConnectionError,
          connections: [{ name: conn.name, url, authProvider: o.provider(principal) }],
        }).open(principal);
      },
    };
  }

  async function openNamed(names: string[], principal: Principal): Promise<OpenToolSet> {
    const all = await store.list(principal);
    // Keep requested names; personal precedence (user entries come last).
    const byName = new Map<string, StoredConnection>();
    for (const c of all) if (names.includes(c.name)) byName.set(c.name, c);

    const tools: Record<string, unknown> = {};
    const toolApproval: Record<string, unknown> = {};
    const alwaysActive: string[] = [];
    const closes: Array<() => Promise<void>> = [];

    for (const conn of byName.values()) {
      const isOAuthMcp = conn.kind === "mcp" && conn.mcp && conn.auth?.kind === "oauth";
      const source =
        conn.kind === "mcp" && conn.mcp
          ? isOAuthMcp
            ? mcpOAuthSource(conn)
            : mcpTokenSource(conn)
          : conn.kind === "openapi" && conn.openapi
            ? openapiSource(conn)
            : undefined;
      if (!source) continue;
      const opened = await source.open(principal);
      Object.assign(tools, opened.tools);
      Object.assign(toolApproval, opened.toolApproval ?? {});
      if (opened.alwaysActive) alwaysActive.push(...opened.alwaysActive);
      closes.push(opened.close);

      // OAuth MCP always exposes a gated connect_<name> (present even when
      // authorized, so an approved historical call can execute on resume).
      if (isOAuthMcp) {
        const key = `connect_${conn.name}`;
        tools[key] = connectTool(conn.name);
        toolApproval[key] = "user-approval";
        alwaysActive.push(key);
      }
    }
    return {
      tools,
      toolApproval,
      alwaysActive,
      close: () =>
        Promise.all(closes.map((c) => c().catch(() => {}))).then(() => undefined),
    };
  }

  return {
    hostFor: (names) => ({ open: (principal) => openNamed(names, principal) }),

    oauth: (name) => oauthFor(name),

    async status(principal) {
      const conns = await store.list(principal);
      const out: ConnectionStatus[] = [];
      for (const c of conns) {
        if (c.kind !== "mcp") continue;
        const isOAuth = c.auth?.kind === "oauth";
        out.push({
          name: c.name,
          oauth: isOAuth,
          authorized: isOAuth ? await oauthFor(c.name).isAuthorized(principal) : true,
        });
      }
      return out;
    },

    async testTools(name, principal) {
      const opened = await openNamed([name], principal);
      try {
        return Object.keys(opened.tools).filter((k) => !k.startsWith("connect_"));
      } finally {
        await opened.close();
      }
    },
  };
}
