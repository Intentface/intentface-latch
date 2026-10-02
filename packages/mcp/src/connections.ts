import { tool, jsonSchema } from "ai";
import type { OAuthClientMetadata } from "@ai-sdk/mcp";
import type {
  SecretResolver,
  Vault,
  OpenToolSet,
  ToolSource,
} from "@intentface/latch-core";
import { createMcpHost } from "./host.js";
import type { McpConnection, McpApprovalPolicy, McpToolInfo } from "./host.js";
import { createMcpOAuth } from "./oauth.js";
import type { McpOAuth } from "./oauth.js";
import { createOAuthDiscoveryFetch } from "./oauth-fetch.js";
import type { FetchFunction } from "./oauth-fetch.js";
import { createGuardedFetch, type GuardedFetch } from "./guarded-fetch.js";

/**
 * Declarative MCP connections — the developer-facing surface.
 *
 * A customer writes one `defineMcpConnection({ url, description, auth })` per
 * server (eve-style), then hands the set to `createMcpConnections`. The registry
 * owns everything else: tool discovery, the SSRF allowlist, OAuth (PKCE/DCR,
 * token storage in the Vault, discovery-doc normalization), and the synthetic
 * `connect_<name>` tool that lets the agent ask the user to authorize mid-chat.
 * The handler (`@intentface/latch-server`) drives the OAuth routes off it.
 */

/** How a connection authenticates. Build with `none` / `bearer` / `headers` / `oauth`. */
export type McpConnectionAuth<P> =
  | { kind: "none" }
  | {
      kind: "bearer";
      getToken: (principal: P) => string | Promise<string>;
      /** Header the token is sent in (default `Authorization`). */
      header?: string;
      /** Text before the token (default `"Bearer "`; use `""` for a bare key). */
      prefix?: string;
    }
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "oauth"; options: OAuthAuthOptions };

/** Options for an interactive (Authorization Code + PKCE) OAuth connection. */
export interface OAuthAuthOptions {
  /** Requested scope string components, joined with spaces. */
  scopes?: string[];
  /**
   * A pre-registered OAuth client. When set, Dynamic Client Registration (DCR)
   * is SKIPPED and this client is used directly — required for auth servers that
   * don't support DCR (Google, GitHub, Slack, …). Register our callback URL
   * (`<callbackBaseUrl>/<name>/callback`) as an allowed redirect URI with the
   * provider. Omit `clientSecret` for a public PKCE client.
   */
  clientId?: string;
  clientSecret?: string;
  /** Client name advertised during dynamic client registration. */
  clientName?: string;
  /** Token-endpoint auth method (default `"none"` — public PKCE client). */
  tokenEndpointAuthMethod?: string;
  /**
   * Normalize a provider's non-conformant discovery documents (e.g. a proxied
   * `http://` authorization-server reference, or a trailing-slash issuer the
   * SDK's strict RFC 8414 check rejects). `forceScheme: "https"` is the common
   * case; `hosts` bounds the rewrite to those hostnames.
   */
  normalize?: { forceScheme?: "https" | "http"; hosts?: string[] };
  /**
   * Omit the RFC 8707 `resource` parameter from the authorization request and
   * token exchange even when the server's protected-resource metadata
   * advertises one. Google's MCP servers (calendarmcp.googleapis.com, …) do
   * advertise a resource, but the audience-bound token Google then mints is
   * rejected by the MCP server itself (401 `invalid_token`); a plain
   * scope-bearing token is accepted. Set `true` for those servers.
   */
  omitResource?: boolean;
  /**
   * Extra query params appended to the authorization redirect URL — provider
   * extensions the SDK doesn't model, e.g. Google's
   * `{ access_type: "offline", prompt: "consent" }` to be issued a refresh
   * token (without it the connection silently dies when the 1h access token
   * expires, since Google returns no refresh token by default).
   */
  authorizationParams?: Record<string, string>;
  /** Extra client-metadata passthrough (merged into the generated metadata). */
  clientMetadata?: Partial<OAuthClientMetadata>;
  /**
   * Origins permitted to act as this connection's authorization server.
   * Defaults to the MCP server's own origin — set this only when the server
   * genuinely delegates authorization to a separate IdP, and list that IdP's
   * origin. See `McpOAuthConfig.allowedAuthorizationServers`.
   */
  allowedAuthorizationServers?: string[];
}

export const none = { kind: "none" } as const;

/**
 * A per-caller secret sent on every request. Defaults to
 * `Authorization: Bearer <token>`; servers keyed on `X-API-Key: <token>` pass
 * `{ header: "X-API-Key", prefix: "" }`.
 */
export function bearer<P>(opts: {
  getToken: (principal: P) => string | Promise<string>;
  header?: string;
  prefix?: string;
}): McpConnectionAuth<P> {
  return {
    kind: "bearer",
    getToken: opts.getToken,
    ...(opts.header !== undefined ? { header: opts.header } : {}),
    ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
  };
}

/**
 * The single request header a `bearer` connection sends: `Authorization:
 * Bearer <token>` unless the connection names its own `header` / `prefix`.
 */
export function bearerHeader(
  auth: { header?: string; prefix?: string },
  token: string,
): Record<string, string> {
  const header = auth.header ?? "Authorization";
  const prefix = auth.prefix ?? "Bearer ";
  return { [header]: `${prefix}${token}` };
}

export function headers<P = unknown>(
  headers: Record<string, string>,
): McpConnectionAuth<P> {
  return { kind: "headers", headers };
}

export function oauth<P = unknown>(
  options: OAuthAuthOptions = {},
): McpConnectionAuth<P> {
  return { kind: "oauth", options };
}

/** A declarative MCP connection. The connection's *name* is the registry key. */
export interface McpConnectionDef<P = unknown> {
  /** MCP server URL (HTTP transport). */
  url: string;
  /** Human-readable purpose — surfaced to the user; helps the model choose it. */
  description?: string;
  /** Auth strategy (default: none). */
  auth?: McpConnectionAuth<P>;
  /** Restrict the exposed tools by their *server-local* name (pre-namespacing). */
  tools?: { allow?: string[]; block?: string[] };
  /**
   * Which of this connection's tools require human approval. Default
   * `"destructive"` — respect the MCP server's own annotations (gate tools it
   * marks destructive / not read-only). `"all"`, `"none"`, or a per-tool
   * predicate `(tool) => boolean` — which may instead return a per-CALL
   * function `(input) => boolean | Promise<boolean>`, evaluated with the
   * model's arguments each call, for meta-tool servers whose one tool
   * multiplexes every operation (gate `execute_tool` only when
   * `input.toolName` starts with `create_`).
   * For policy that varies by caller, use {@link approvalFor} instead.
   */
  approval?: McpApprovalPolicy;
  /**
   * Per-principal approval resolver — awaited at open time to produce the
   * approval policy for this caller (e.g. per-user permissions from a DB).
   * Takes precedence over {@link approval} when set.
   */
  approvalFor?: (principal: P) => McpApprovalPolicy | Promise<McpApprovalPolicy>;
  /**
   * Tool visibility filter — a tool for which it returns `false` is dropped
   * entirely (no tool, no approval entry). A per-tool predicate
   * `(tool) => boolean`, for a hard block an approval policy can't express. For
   * visibility that varies by caller, use {@link visibleToolsFor} instead.
   */
  visibleTools?: (tool: McpToolInfo) => boolean;
  /**
   * Per-principal visibility resolver — awaited at open time to produce the
   * visibility predicate for this caller. Takes precedence over
   * {@link visibleTools} when set.
   */
  visibleToolsFor?: (
    principal: P,
  ) => ((tool: McpToolInfo) => boolean) | Promise<(tool: McpToolInfo) => boolean>;
  /**
   * Permit this connection to reach a private/internal address. Off by default
   * (the host blocks private/loopback/link-local IPs and DNS rebinding); set
   * `true` only for a trusted local/in-cluster MCP server.
   */
  allowPrivateHost?: boolean;
}

/** Identity helper — keeps connection files declarative and typed. */
export function defineMcpConnection<P = unknown>(
  def: McpConnectionDef<P>,
): McpConnectionDef<P> {
  return def;
}

export interface McpConnectionsConfig<P> {
  vault: Vault<P>;
  /** Read-side for bearer secrets, if any bearer connection resolves from the Vault. */
  secrets?: SecretResolver<P>;
  /** SSRF allowlist (see `createMcpHost`). */
  allowedHosts: string[] | ((principal: P) => string[] | Promise<string[]>);
  /** Connection set, keyed by name. */
  connections: Record<string, McpConnectionDef<P>>;
  /**
   * Base URL the OAuth callback lands on, e.g.
   * `https://app.example.com/api/latch/connections`. The registry appends
   * `/<name>/callback` to build each connection's exact redirect URI.
   */
  callbackBaseUrl?: string;
  /** Observe a connection that failed to open (skipped, not fatal). */
  onConnectionError?: (name: string, error: unknown) => void;
}

/** Per-connection status for a tenant. */
export interface ConnectionStatus {
  name: string;
  description?: string;
  /** True if this connection uses interactive OAuth. */
  oauth: boolean;
  /** True if usable now (non-OAuth are always true; OAuth → tokens present). */
  authorized: boolean;
}

export interface McpConnections<P> {
  /** A `ToolSource` over ALL connections: authorized tools + connect_* tools. */
  host: ToolSource<P>;
  /**
   * A `ToolSource` scoped to the named connections only — what the runtime uses
   * to resolve an agent's `connections: [...]`. Unknown names are ignored.
   */
  hostFor(names: string[]): ToolSource<P>;
  /** Declared connection names. */
  names: string[];
  /** The OAuth flow for a connection (undefined if it isn't an OAuth connection). */
  oauth(name: string): McpOAuth<P> | undefined;
  /** Per-connection status for the caller. */
  status(principal: P): Promise<ConnectionStatus[]>;
  /** Open just one connection and return its namespaced tool names (a connectivity probe). */
  testTools(name: string, principal: P): Promise<string[]>;
  /**
   * Release the registry's own resources — one address-guarded fetch per
   * connection, each holding a keep-alive agent. These live for the registry's
   * lifetime by design (a per-turn agent would discard every pooled socket), so
   * a long-lived server never needs this; a test or a short-lived process does,
   * or the sockets keep the event loop alive. Opening tool sets is unaffected —
   * `OpenToolSet.close()` still releases a turn's clients.
   *
   * Optional: a host that hand-builds something satisfying this interface (the
   * platform composes several) owns no such resources and need not implement it.
   */
  close?(): Promise<void>;
  /**
   * Open just one connection and describe the tools the caller would get:
   * server-local `name`, `description`, `annotations` — after the connection's
   * `tools` allow/block and the caller's `visibleTools(For)` filter, exactly the
   * set a turn would expose. For settings UIs that let a person pick tools.
   *
   * Optional, like `close`: a hand-built registry need not offer it.
   */
  listTools?(name: string, principal: P): Promise<McpToolInfo[]>;
}

/** Build the synthetic tool that asks the user to authorize a connection. */
function connectTool(name: string, def: { description?: string }) {
  return tool({
    description:
      `Connect the "${name}" integration` +
      (def.description ? ` (${def.description})` : "") +
      `. The user must authorize access first — calling this prompts them to ` +
      `connect. Only call it when ${name}'s own tools are not already available.`,
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => ({ connected: true, connection: name }),
  });
}

/** True if a server-local tool name passes the connection's allow/block filter. */
function toolAllowed(
  localName: string,
  filter: McpConnectionDef<unknown>["tools"],
): boolean {
  if (!filter) return true;
  if (filter.block?.includes(localName)) return false;
  if (filter.allow && !filter.allow.includes(localName)) return false;
  return true;
}

export function createMcpConnections<P>(
  config: McpConnectionsConfig<P>,
): McpConnections<P> {
  const entries = Object.entries(config.connections);

  // One McpOAuth + address-guarded fetch per connection, built up front.
  const oauthByName = new Map<string, McpOAuth<P>>();
  const fetchByName = new Map<string, FetchFunction>();
  const guardedByName = new Map<string, GuardedFetch>();

  // EVERY connection gets a fetch that vets addresses inside the lookup its own
  // socket uses — the transport's requests and, for OAuth connections, every
  // leg of the flow. Checking a hostname and then handing it to `fetch` leaves
  // the name free to resolve somewhere else when the socket opens, which would
  // carry the caller's credentials to whatever answers. `allowPrivateHost`
  // relaxes it per connection, so a developer's loopback server still works.
  for (const [name, def] of entries) {
    const guarded = createGuardedFetch({ allowPrivateHost: def.allowPrivateHost });
    guardedByName.set(name, guarded);
    const normalize = def.auth?.kind === "oauth" ? def.auth.options.normalize : undefined;
    // Discovery normalization, when the host asked for it, sits ON TOP: it sees
    // the documents, the guarded fetch still opens the sockets.
    fetchByName.set(
      name,
      normalize
        ? createOAuthDiscoveryFetch({ ...normalize, baseFetch: guarded })
        : (guarded as FetchFunction),
    );
  }

  for (const [name, def] of entries) {
    if (def.auth?.kind !== "oauth") continue;
    const opts = def.auth.options;
    const redirectUrl = config.callbackBaseUrl
      ? `${config.callbackBaseUrl.replace(/\/$/, "")}/${name}/callback`
      : undefined;
    const normFetch = fetchByName.get(name);
    if (!redirectUrl) {
      // Without a callback base we can't run the redirect flow; skip building
      // the OAuth client (status will still report it as an OAuth connection).
      continue;
    }
    const clientMetadata: OAuthClientMetadata = {
      client_name: opts.clientName ?? `Latch (${name})`,
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: opts.tokenEndpointAuthMethod ?? "none",
      ...opts.clientMetadata,
    };
    oauthByName.set(
      name,
      createMcpOAuth({
        vault: config.vault,
        config: {
          name,
          serverUrl: def.url,
          redirectUrl,
          clientMetadata,
          // Pre-registered client (skips DCR) when provided — for auth servers
          // without dynamic registration.
          clientInformation: opts.clientId
            ? { client_id: opts.clientId, client_secret: opts.clientSecret }
            : undefined,
          scope: opts.scopes?.join(" "),
          fetch: normFetch,
          // Undefined → the MCP server's own origin (see the option's doc).
          allowedAuthorizationServers: opts.allowedAuthorizationServers,
          // `undefined` keeps the SDK default (exact origin match on the
          // advertised resource); a defined hook returning undefined omits the
          // resource parameter from the authorize + exchange requests.
          validateResourceURL: opts.omitResource ? () => undefined : undefined,
          authorizationParams: opts.authorizationParams,
        },
      }),
    );
  }

  /** Resolve the real (server-backed) connections for a caller this turn. */
  async function resolveConnections(principal: P): Promise<McpConnection[]> {
    const out: McpConnection[] = [];
    for (const [name, def] of entries) {
      const auth = def.auth ?? none;
      // `*For` resolvers vary by caller (awaited per turn); they take precedence
      // over the static `approval`/`visibleTools`. A resolver failure skips just
      // this connection (graceful degradation, like a connect-time failure)
      // instead of rejecting the whole host.
      let approval = def.approval;
      let visible = def.visibleTools;
      try {
        if (def.approvalFor) approval = await def.approvalFor(principal);
        if (def.visibleToolsFor) visible = await def.visibleToolsFor(principal);
      } catch (error) {
        config.onConnectionError?.(name, error);
        continue;
      }
      if (auth.kind === "oauth") {
        const o = oauthByName.get(name);
        // Include the live connection only once the caller has authorized.
        if (o && (await o.isAuthorized(principal))) {
          out.push({
            name,
            url: def.url,
            authProvider: o.provider(principal),
            fetch: fetchByName.get(name),
            approval,
            visible,
            allowPrivateHost: def.allowPrivateHost,
          });
        }
      } else if (auth.kind === "bearer") {
        const token = await auth.getToken(principal);
        out.push({
          name,
          url: def.url,
          auth: { type: "headers", headers: bearerHeader(auth, token) },
          fetch: fetchByName.get(name),
          approval,
          visible,
          allowPrivateHost: def.allowPrivateHost,
        });
      } else if (auth.kind === "headers") {
        out.push({
          name,
          url: def.url,
          auth: { type: "headers", headers: auth.headers },
          fetch: fetchByName.get(name),
          approval,
          visible,
          allowPrivateHost: def.allowPrivateHost,
        });
      } else {
        out.push({
          name,
          url: def.url,
          fetch: fetchByName.get(name),
          approval,
          visible,
          allowPrivateHost: def.allowPrivateHost,
        });
      }
    }
    return out;
  }

  const filterByName = new Map(
    entries.map(([name, def]) => [name, def.tools] as const),
  );

  /**
   * A tool source over the connections in `only` (or all, if undefined):
   * each authorized connection's filtered tools, plus a gated `connect_<name>`
   * for every OAuth connection in scope (present even when authorized, so an
   * approved historical call can execute on resume).
   */
  function makeHost(only?: Set<string>): ToolSource<P> {
    const inScope = (name: string) => !only || only.has(name);
    const hostInstance = createMcpHost<P>({
      secrets: config.secrets,
      allowedHosts: config.allowedHosts,
      onConnectionError: config.onConnectionError,
      connections: async (principal) =>
        (await resolveConnections(principal)).filter((c) => inScope(c.name)),
    });

    return {
      async open(principal): Promise<OpenToolSet> {
        const opened = await hostInstance.open(principal);

        // Apply per-connection allow/block on the server-local tool name.
        const tools: Record<string, unknown> = {};
        for (const [key, t] of Object.entries(opened.tools)) {
          const us = key.indexOf("_");
          const conn = us === -1 ? key : key.slice(0, us);
          const local = us === -1 ? key : key.slice(us + 1);
          if (toolAllowed(local, filterByName.get(conn))) tools[key] = t;
        }

        // Start from the host's annotation-derived gating (only for the tools
        // that survived the allow/block filter), then add the connect_* gates.
        const toolApproval: Record<string, unknown> = {};
        for (const [key, status] of Object.entries(opened.toolApproval)) {
          if (key in tools) toolApproval[key] = status;
        }
        const alwaysActive: string[] = [];
        for (const [name, def] of entries) {
          if (def.auth?.kind !== "oauth" || !inScope(name)) continue;
          const key = `connect_${name}`;
          tools[key] = connectTool(name, def);
          toolApproval[key] = "user-approval";
          alwaysActive.push(key); // keep the auth tool callable under enabledTools
        }

        return { tools, close: opened.close, toolApproval, alwaysActive };
      },
    };
  }

  /** Open just one connection — so a probe or a tool listing never touches the other servers. */
  async function openOne(name: string, principal: P) {
    const def = config.connections[name];
    if (!def) throw new Error(`Unknown connection: ${name}`);
    const probe = createMcpHost<P>({
      secrets: config.secrets,
      allowedHosts: config.allowedHosts,
      onConnectionError: config.onConnectionError,
      connections: async (p) => {
        const all = await resolveConnections(p);
        return all.filter((c) => c.name === name);
      },
    });
    return { def, opened: await probe.open(principal) };
  }

  return {
    host: makeHost(),
    hostFor: (names) => makeHost(new Set(names)),
    names: entries.map(([name]) => name),
    oauth: (name) => oauthByName.get(name),
    async close() {
      await Promise.all([...guardedByName.values()].map((f) => f.close().catch(() => {})));
    },
    async status(principal) {
      const out: ConnectionStatus[] = [];
      for (const [name, def] of entries) {
        const isOAuth = def.auth?.kind === "oauth";
        const o = oauthByName.get(name);
        out.push({
          name,
          description: def.description,
          oauth: isOAuth,
          authorized: isOAuth ? (o ? await o.isAuthorized(principal) : false) : true,
        });
      }
      return out;
    },
    async testTools(name, principal) {
      const { opened } = await openOne(name, principal);
      try {
        return Object.keys(opened.tools);
      } finally {
        await opened.close();
      }
    },
    async listTools(name, principal) {
      const { def, opened } = await openOne(name, principal);
      try {
        // Same allow/block the turn applies (makeHost), on the server-local name.
        return Object.values(opened.toolInfos).filter((info) =>
          toolAllowed(info.name, def.tools),
        );
      } finally {
        await opened.close();
      }
    },
  };
}
