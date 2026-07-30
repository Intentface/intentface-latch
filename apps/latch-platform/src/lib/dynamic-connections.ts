import { tool, jsonSchema } from "ai";
import type {
  ConnectionRegistry,
  OpenToolSet,
  ToolSource,
  Vault,
} from "@intentface/latch-core";
import type { ConnectionStatus, McpAuth, McpOAuth } from "@intentface/latch-mcp";
import { createMcpHost, createMcpOAuth, createOAuthDiscoveryFetch } from "@intentface/latch-mcp";
import type { OpenApiAuth } from "@intentface/latch-openapi";
import {
  bearer as openApiBearer,
  createOpenApiConnections,
  defineOpenApiConnection,
  headers as openApiHeaders,
} from "@intentface/latch-openapi";
import type { Principal } from "./session";
import type { ConnectionStore, StoredConnection } from "./connection-store";
import type { OAuth2Flow } from "./oauth2-flow";
import { createOAuth2Flow } from "./oauth2-flow";

/**
 * A ConnectionRegistry backed by the Vault-stored connections (added via UI).
 * `hostFor(names)` resolves an agent's declared names against the caller's
 * in-scope connections (org-shared + personal) at turn time and builds their
 * tools — MCP or OpenAPI — with the token brokered server-side. Names not found
 * in scope are simply absent (the agent degrades gracefully).
 *
 * MCP connections can authenticate three ways: a static `bearer`/`header` token,
 * or interactive `oauth` (no stored secret — the per-user tokens come from the
 * browser flow). OpenAPI connections take a static token or `oauth2` — a
 * pre-registered classic OAuth2 client (explicit endpoints + client credentials
 * in the stored blob) whose per-user grants are brokered by `createOAuth2Flow`.
 * Interactive connections of either kind expose a gated `connect_<name>` tool so
 * the agent can ask the user to authorize mid-chat, exactly like code-declared
 * ones. The registry therefore also surfaces the handler's connection routes
 * (`oauth`/`status`/`testTools`) for those UI connections.
 */
const hostOf = (u: string) => new URL(u).hostname;

/** Static token auth → MCP request headers (oauth/oauth2 carry no static token). */
function mcpAuth(auth: StoredConnection["auth"]): McpAuth | undefined {
  if (!auth || auth.kind === "oauth" || auth.kind === "oauth2") return undefined;
  const headers =
    auth.kind === "bearer"
      ? { Authorization: `Bearer ${auth.token}` }
      : { [auth.header ?? "Authorization"]: auth.token };
  return { type: "headers", headers };
}

/** Static token auth → OpenAPI header resolver (oauth2 is resolved per call instead). */
function openApiAuth(auth: StoredConnection["auth"]): OpenApiAuth<Principal> | undefined {
  if (!auth || auth.kind === "oauth" || auth.kind === "oauth2") return undefined;
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
  /** The OAuth flow for a UI-added connection (always returns one; only meaningful for oauth MCP / oauth2 OpenAPI). */
  oauth: (name: string) => McpOAuth<Principal>;
  /** Status of the caller's interactive UI-added connections (oauth + authorized). */
  status: (principal: Principal) => Promise<ConnectionStatus[]>;
  /** Open one connection and list its namespaced tool names (a connectivity probe). */
  testTools: (name: string, principal: Principal) => Promise<string[]>;
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

  // Normalize non-conformant OAuth discovery from proxied MCP servers: force the
  // https scheme (servers behind TLS-terminating proxies advertise http) and
  // strip the issuer's trailing slash (the SDK's RFC 8414 check is strict).
  // Same shared fetch goes to both the OAuth flow and the host (on-401 re-auth).
  const discoveryFetch = createOAuthDiscoveryFetch({ forceScheme: "https" });

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
          fetch: discoveryFetch,
        },
      });
      oauthCache.set(name, o);
    }
    return o;
  }

  // One OAuth2 flow per name, mirroring oauthCache. The endpoints + client
  // credentials are re-read from the caller's stored connection on every use
  // (same lazy pattern as `serverUrl` above), so re-adding a connection with
  // new credentials needs no cache invalidation here.
  const oauth2Cache = new Map<string, OAuth2Flow<Principal>>();
  function oauth2FlowFor(name: string): OAuth2Flow<Principal> {
    let o = oauth2Cache.get(name);
    if (!o) {
      o = createOAuth2Flow<Principal>({
        vault,
        name,
        callbackBaseUrl: callbackBase,
        config: async (p) => {
          const conn = await store.get(p, name);
          if (!conn || conn.kind !== "openapi" || !conn.openapi || conn.auth?.kind !== "oauth2") {
            throw new Error(`Connection "${name}" is not configured for OAuth2`);
          }
          return {
            ...conn.auth,
            // Fold the API target into the grant identity: retargeting the
            // connection (new spec/baseUrl) must invalidate grants minted for
            // the old API, not send its bearer tokens to the new host.
            fingerprint: JSON.stringify([conn.openapi.spec, conn.openapi.baseUrl ?? null]),
          };
        },
        ownerKey: (p) => `${p.orgId}/${p.userId ?? ""}`,
      });
      oauth2Cache.set(name, o);
    }
    return o;
  }

  function openapiSource(conn: StoredConnection): ToolSource<Principal> {
    const o = conn.openapi!;
    // Auth is part of the key so a re-add that changes credentials doesn't
    // reuse a registry built with a stale auth closure. In-memory only.
    const sig = `${conn.name}:${o.spec}:${o.baseUrl ?? ""}:${JSON.stringify(conn.auth ?? null)}`;
    let reg = openapiCache.get(sig);
    if (!reg) {
      const hosts = [hostOf(o.spec), ...(o.baseUrl ? [hostOf(o.baseUrl)] : [])];
      // oauth2 → a live per-user bearer token, resolved on every tool call (the
      // registry is built once and shared across principals, so the closure
      // must only capture the connection name). An unauthorized/dead grant
      // yields no header → the API's own 401 comes back as a tool result.
      const auth =
        conn.auth?.kind === "oauth2"
          ? openApiBearer<Principal>({
              getToken: (p) =>
                oauth2FlowFor(conn.name)
                  .accessTokenFor(p)
                  .catch(() => undefined),
            })
          : openApiAuth(conn.auth);
      reg = createOpenApiConnections<Principal>({
        allowedHosts: hosts,
        connections: {
          [conn.name]: defineOpenApiConnection<Principal>({
            spec: o.spec,
            baseUrl: o.baseUrl,
            operations: o.operations ? { allow: o.operations } : undefined,
            auth,
          }),
        },
        onConnectionError,
      });
      openapiCache.set(sig, reg);
    }
    return reg.hostFor([conn.name]);
  }

  /** Open an authorized oauth2 OpenAPI connection's live tools (empty until connected). */
  function openapiOAuth2Source(conn: StoredConnection): ToolSource<Principal> {
    return {
      async open(principal): Promise<OpenToolSet> {
        if (!(await oauth2FlowFor(conn.name).isAuthorized(principal))) {
          return { tools: {}, toolApproval: {}, close: async () => {} };
        }
        return openapiSource(conn).open(principal);
      },
    };
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
          connections: [
            { name: conn.name, url, authProvider: o.provider(principal), fetch: discoveryFetch },
          ],
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
      const isOAuth2OpenApi =
        conn.kind === "openapi" && conn.openapi && conn.auth?.kind === "oauth2";
      const source =
        conn.kind === "mcp" && conn.mcp
          ? isOAuthMcp
            ? mcpOAuthSource(conn)
            : mcpTokenSource(conn)
          : conn.kind === "openapi" && conn.openapi
            ? isOAuth2OpenApi
              ? openapiOAuth2Source(conn)
              : openapiSource(conn)
            : undefined;
      if (!source) continue;
      const opened = await source.open(principal);
      Object.assign(tools, opened.tools);
      Object.assign(toolApproval, opened.toolApproval ?? {});
      if (opened.alwaysActive) alwaysActive.push(...opened.alwaysActive);
      closes.push(opened.close);

      // Interactive connections always expose a gated connect_<name> (present
      // even when authorized, so an approved historical call can execute on resume).
      if (isOAuthMcp || isOAuth2OpenApi) {
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

  // The stored auth kind decides which flow serves a name, but it isn't
  // knowable without a principal (the connection lives in the caller's Vault
  // scope) — so the public `oauth(name)` dispatches per call. Unknown or
  // non-oauth2 names fall through to the MCP flow, preserving its error text.
  async function flowFor(principal: Principal, name: string): Promise<McpOAuth<Principal>> {
    const conn = await store.get(principal, name);
    return conn?.auth?.kind === "oauth2" ? oauth2FlowFor(name) : oauthFor(name);
  }

  return {
    hostFor: (names) => ({ open: (principal) => openNamed(names, principal) }),

    // NOTE: only the handler consumes this surface (start/finish/isAuthorized +
    // provider().invalidateCredentials on disconnect). The MCP client itself
    // must keep getting the real OAuthClientProvider from `oauthFor` — see
    // mcpOAuthSource, which deliberately bypasses this dispatcher.
    oauth: (name) => ({
      isAuthorized: async (p) => (await flowFor(p, name)).isAuthorized(p),
      start: async (p, o) => (await flowFor(p, name)).start(p, o),
      finish: async (p, params) => (await flowFor(p, name)).finish(p, params),
      provider: (p) =>
        ({
          invalidateCredentials: async (scope: string) =>
            (await flowFor(p, name)).provider(p).invalidateCredentials?.(scope as never),
        }) as unknown as ReturnType<McpOAuth<Principal>["provider"]>,
    }),

    async status(principal) {
      const conns = await store.list(principal);
      const out: ConnectionStatus[] = [];
      for (const c of conns) {
        if (c.kind === "mcp") {
          const isOAuth = c.auth?.kind === "oauth";
          out.push({
            name: c.name,
            oauth: isOAuth,
            authorized: isOAuth ? await oauthFor(c.name).isAuthorized(principal) : true,
          });
        } else if (c.auth?.kind === "oauth2") {
          out.push({
            name: c.name,
            oauth: true,
            authorized: await oauth2FlowFor(c.name).isAuthorized(principal),
          });
        }
        // Other OpenAPI connections stay out of status (always usable);
        // listConnectionsFn defaults them to authorized.
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
