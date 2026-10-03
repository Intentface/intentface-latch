import { tool, jsonSchema } from "ai";
import { clientErrorMessage } from "@intentface/latch-core";
import type {
  ConnectionRegistry,
  OpenToolSet,
  ToolSource,
  Vault,
} from "@intentface/latch-core";
import type { ConnectionStatus, McpAuth, McpOAuth } from "@intentface/latch-mcp";
import { createMcpHost, createMcpOAuth, createOAuthDiscoveryFetch } from "@intentface/latch-mcp";
import { pinnedFetch } from "@intentface/latch-net/pinned";
import type { OpenApiAuth } from "@intentface/latch-openapi";
import {
  bearer as openApiBearer,
  createOpenApiConnections,
  defineOpenApiConnection,
} from "@intentface/latch-openapi";
import { credentialPrincipalOf } from "./session";
import type { Principal } from "./session";
import type { ConnectionStore, ScopedConnection } from "./connection-store";
import type { NamedSecrets } from "./named-secrets";
import { defaultSecretName, requireSecret } from "./named-secrets";
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
 *
 * CREDENTIALS ARE RESOLVED HERE, at egress, from the named secret a connection
 * points at — never copied into the connection record. Replacing a secret on the
 * Secrets page therefore rotates every connection built on it, and deleting one
 * revokes them. The three resolution points are the oauth2 client secret (per
 * token POST), the OpenAPI static token (per tool call) and the MCP static token
 * (per turn, since transport headers are fixed when the socket opens).
 */
const hostOf = (u: string) => new URL(u).hostname;

/**
 * A static token's plaintext, from either the referenced secret or a legacy
 * inline value. Throws when a referenced secret is gone — the callers turn that
 * into a connection that contributes no tools, rather than one that sends
 * unauthenticated requests.
 */
async function staticToken(
  secrets: NamedSecrets,
  conn: ScopedConnection,
  principal: Principal,
): Promise<string | undefined> {
  const auth = conn.auth;
  if (!auth || auth.kind === "oauth" || auth.kind === "oauth2") return undefined;
  if (auth.tokenRef) {
    return requireSecret(secrets, principal, auth.tokenRef, conn.scope, conn.name);
  }
  return auth.token;
}

/** Static token → the request headers it belongs in (`Authorization` unless overridden). */
function tokenHeaders(conn: ScopedConnection, token: string): Record<string, string> {
  const auth = conn.auth;
  return auth?.kind === "header"
    ? { [auth.header ?? "Authorization"]: token }
    : { Authorization: `Bearer ${token}` };
}

/**
 * The synthetic tool that asks the user to (re)authorize a connection.
 * Approval-gated by the caller when the connection is unauthorized or broken;
 * ungated (an immediate no-op) when it's live. `openError` carries the reason
 * a declared connection failed to open, so the MODEL knows the difference
 * between "never connected" and "connected but broken" — and so does whoever
 * reads the transcript.
 */
function connectTool(name: string, openError?: string) {
  return tool({
    description: openError
      ? `Reconnect the "${name}" integration. It is configured but FAILED to open ` +
        `this turn (${openError.slice(0, 200)}); its tools are unavailable until it is ` +
        `reconnected. Calling this prompts the user to reconnect.`
      : `Connect the "${name}" integration. The user must authorize access first — ` +
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
  /** Where a connection's `*Ref` credentials are read from, at egress. */
  secrets: NamedSecrets;
  vault: Vault<Principal>;
  /** Base the OAuth callback lands on, e.g. `https://app/api/latch/connections`. */
  callbackBaseUrl: string;
  onConnectionError?: (name: string, error: unknown) => void;
}): DynamicConnections {
  const { store, secrets, vault, onConnectionError } = opts;
  const callbackBase = opts.callbackBaseUrl.replace(/\/$/, "");

  // GRANTS live under the ACTING human; CONFIG resolves under the turn's own
  // principal. The OAuth flows receive this wrapped vault, so every token/
  // verifier/client/state read-write maps the principal through
  // credentialPrincipalOf — while their lazy config resolvers (store.get for
  // serverUrl/scopes/client secrets) keep the FULL turn principal and thus the
  // binding's view of which connection a name means. Splitting here (rather
  // than wrapping principals at call sites) is what prevents the config-
  // substitution hole: with grant-keyed config lookups, an actor's same-named
  // PERSONAL connection (personal wins over org in store.get) could point an
  // org binding's flow at an arbitrary serverUrl.
  const grantVault: Vault<Principal> = {
    set: (p, k, v) => vault.set(credentialPrincipalOf(p), k, v),
    get: (p, k) => vault.get(credentialPrincipalOf(p), k),
    has: (p, k) => vault.has(credentialPrincipalOf(p), k),
    delete: (p, k) => vault.delete(credentialPrincipalOf(p), k),
    list: (p) => vault.list(credentialPrincipalOf(p)),
    resolver: vault.resolver,
  };

  // Normalize non-conformant OAuth discovery from proxied MCP servers: force the
  // https scheme (servers behind TLS-terminating proxies advertise http) and
  // strip the issuer's trailing slash (the SDK's RFC 8414 check is strict).
  // Same shared fetch goes to both the OAuth flow and the host (on-401 re-auth).
  const discoveryFetch = createOAuthDiscoveryFetch({ forceScheme: "https" });

  // Development only: let user-added MCP connections reach a server on THIS
  // machine — a local MCP server on localhost. Loopback only: the rest of the
  // private ranges (cloud metadata at 169.254.169.254, internal services) stay
  // blocked even with the flag on, so a shared dev or staging deployment that
  // sets it can't be pointed at its own network. Never in production.
  const localhostAllowed =
    process.env.LATCH_ALLOW_LOCALHOST_MCP === "1" && process.env.NODE_ENV !== "production";
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const allowPrivateHostFor = (url: string) => {
    if (!localhostAllowed) return false;
    try {
      return LOOPBACK.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

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
        vault: grantVault,
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
          // Requested scopes come from the caller's own connection record, and
          // must be resolved lazily for the same reason as `serverUrl`: this
          // McpOAuth is cached per connection NAME while the record is
          // per-caller, so a static value would request one caller's scopes on
          // another's behalf. Undefined when unset, so connections that ask for
          // nothing keep their current, scope-less authorize request.
          scope: async (p) => {
            const conn = await store.get(p, name);
            const scopes = conn?.auth?.kind === "oauth" ? conn.auth.scopes : undefined;
            return scopes?.length ? scopes.join(" ") : undefined;
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
        vault: grantVault,
        name,
        callbackBaseUrl: callbackBase,
        config: async (p) => {
          const conn = await store.get(p, name);
          if (!conn || conn.kind !== "openapi" || !conn.openapi || conn.auth?.kind !== "oauth2") {
            throw new Error(`Connection "${name}" is not configured for OAuth2`);
          }
          const { clientSecretRef } = conn.auth;
          const clientSecret = clientSecretRef
            ? await requireSecret(secrets, p, clientSecretRef, conn.scope, name)
            : (conn.auth.clientSecret ?? "");
          return {
            ...conn.auth,
            clientSecret,
            // Fold the API target and the credential's IDENTITY into the grant
            // fingerprint. Retargeting the connection (new spec/baseUrl) must
            // invalidate grants minted for the old API rather than send its
            // bearer tokens to the new host; repointing at a *different* named
            // secret is likewise a different client, so it forces re-consent.
            //
            // Pointing at this connection's OWN secret is the baseline and
            // contributes nothing, which is what makes two migrations invisible:
            // a legacy inline secret becoming a ref on first retype (same
            // credential, new home), and this very field being introduced
            // (grants minted before refs existed stay valid).
            fingerprint: JSON.stringify(
              clientSecretRef && clientSecretRef !== defaultSecretName(name, "client_secret")
                ? [conn.openapi.spec, conn.openapi.baseUrl ?? null, clientSecretRef]
                : [conn.openapi.spec, conn.openapi.baseUrl ?? null],
            ),
          };
        },
        ownerKey: (p) => {
          const c = credentialPrincipalOf(p);
          return `${c.orgId}/${c.userId ?? ""}`;
        },
      });
      oauth2Cache.set(name, o);
    }
    return o;
  }

  function openapiSource(conn: ScopedConnection): ToolSource<Principal> {
    const o = conn.openapi!;
    // Auth is part of the key so a re-add that changes credentials doesn't
    // reuse a registry built with a stale auth closure — but note the key is
    // deliberately STABLE across a secret's value changing, because the value is
    // no longer in here: it's read per call below. Scope is part of the key too,
    // since it decides which secret a `*Ref` resolves against. In-memory only.
    const sig = `${conn.scope}:${conn.name}:${o.spec}:${o.baseUrl ?? ""}:${JSON.stringify(conn.auth ?? null)}`;
    let reg = openapiCache.get(sig);
    if (!reg) {
      const hosts = [hostOf(o.spec), ...(o.baseUrl ? [hostOf(o.baseUrl)] : [])];
      // Both auth kinds resolve on every tool call — the registry is built once
      // and shared across principals, so the closures must capture nothing but
      // the connection record.
      //
      // oauth2 → a live per-user bearer token; an unauthorized/dead grant yields
      // no header and the API's own 401 comes back as a tool result. A static
      // token instead THROWS when its secret has been deleted: a revoked
      // credential must fail the call, not quietly make it anonymous.
      const auth: OpenApiAuth<Principal> | undefined =
        conn.auth?.kind === "oauth2"
          ? openApiBearer<Principal>({
              getToken: (p) =>
                oauth2FlowFor(conn.name)
                  .accessTokenFor(p)
                  .catch(() => undefined),
            })
          : conn.auth && conn.auth.kind !== "oauth"
            ? async (p) => {
                const token = await staticToken(secrets, conn, p);
                return token ? tokenHeaders(conn, token) : {};
              }
            : undefined;
      reg = createOpenApiConnections<Principal>({
        allowedHosts: hosts,
        // DNS-pinned: vets addresses at connect time for BOTH the spec
        // download and every tool call (the pre-checks inside the registry
        // remain the well-messaged first gate).
        fetch: pinnedFetch,
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
  function openapiOAuth2Source(conn: ScopedConnection): ToolSource<Principal> {
    return {
      async open(principal): Promise<OpenToolSet> {
        if (!(await oauth2FlowFor(conn.name).isAuthorized(principal))) {
          return { tools: {}, toolApproval: {}, close: async () => {} };
        }
        return openapiSource(conn).open(principal);
      },
    };
  }

  /**
   * Open a static-token (or no-auth) MCP connection's live tools.
   *
   * The token is resolved when the transport connects, so a rotation lands on
   * the NEXT turn rather than the next call — MCP fixes its request headers at
   * connect time, unlike OpenAPI's per-call resolver. Deliberate asymmetry: the
   * alternative is reconnecting mid-turn on every tool call.
   */
  function mcpTokenSource(conn: ScopedConnection): ToolSource<Principal> {
    const url = conn.mcp!.url;
    return {
      async open(principal): Promise<OpenToolSet> {
        const token = await staticToken(secrets, conn, principal);
        const auth: McpAuth | undefined = token
          ? { type: "headers", headers: tokenHeaders(conn, token) }
          : undefined;
        return createMcpHost<Principal>({
          allowedHosts: [hostOf(url)],
          onConnectionError,
          connections: [{ name: conn.name, url, auth, allowPrivateHost: allowPrivateHostFor(url) }],
        }).open(principal);
      },
    };
  }

  /** Open an authorized OAuth MCP connection's live tools (auto-refreshing). */
  function mcpOAuthSource(conn: ScopedConnection): ToolSource<Principal> {
    const url = conn.mcp!.url;
    return {
      async open(principal): Promise<OpenToolSet> {
        const o = oauthFor(conn.name);
        // The FULL turn principal flows into the flow: grant storage maps to
        // the acting human inside grantVault, while config lookups keep the
        // binding's view — see grantVault for why the split lives there.
        if (!(await o.isAuthorized(principal))) {
          return { tools: {}, toolApproval: {}, close: async () => {} };
        }
        return createMcpHost<Principal>({
          allowedHosts: [hostOf(url)],
          onConnectionError,
          connections: [
            { name: conn.name, url, authProvider: o.provider(principal), fetch: discoveryFetch, allowPrivateHost: allowPrivateHostFor(url) },
          ],
        }).open(principal);
      },
    };
  }

  async function openNamed(names: string[], principal: Principal): Promise<OpenToolSet> {
    const all = await store.list(principal);
    // Keep requested names; personal precedence (user entries come last).
    const byName = new Map<string, ScopedConnection>();
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
      const interactive = isOAuthMcp || isOAuth2OpenApi;
      let opened: OpenToolSet | null = null;
      try {
        // A connection whose referenced secret has been deleted is REVOKED — it
        // contributes no tools and says why, instead of sending unauthenticated
        // requests. Resolving here (rather than only at call time) makes the
        // tool simply absent, which the agent handles far better than a runtime
        // failure. One bad connection must not take the rest of the turn's
        // tools down with it — but for INTERACTIVE connections the failure must
        // not be silent either (below): a declared connection quietly missing
        // let an agent answer confidently without the plane it was built
        // around, and nobody — user, model, or transcript — could tell.
        await staticToken(secrets, conn, principal);
        opened = await source.open(principal);
      } catch (error) {
        onConnectionError?.(conn.name, error);
        if (!interactive) continue;
        // Fail LOUD for interactive connections: expose a GATED reconnect tool
        // whose description carries the failure, exactly like the unauthorized
        // case. The model confronts the breakage (a gated call parks the turn
        // and renders a connect card) instead of degrading into a generic
        // answer, and the reason is one hover away instead of buried in server
        // logs.
        const key = `connect_${conn.name}`;
        // clientErrorMessage: the one bounded, secret-redacting exposure policy —
        // String(err) on a thrown response object is just "[object Object]".
        tools[key] = connectTool(conn.name, clientErrorMessage(error));
        toolApproval[key] = "user-approval";
        alwaysActive.push(key);
        continue;
      }
      Object.assign(tools, opened.tools);
      Object.assign(toolApproval, opened.toolApproval ?? {});
      if (opened.alwaysActive) alwaysActive.push(...opened.alwaysActive);
      closes.push(opened.close);

      // Interactive connections always expose a connect_<name> (present even
      // when authorized, so an approved historical call can execute on resume) —
      // but the approval gate only applies while UNAUTHORIZED. Once connected,
      // a call executes immediately and returns {connected:true}: a model primed
      // by its own history ("I need to connect first…") course-corrects mid-turn
      // instead of dead-ending into a sign-in card for a connection that is
      // already live. Observed on Slack: connect via the UI didn't resolve the
      // thread's parked card, and every later message re-carded.
      if (interactive) {
        const key = `connect_${conn.name}`;
        tools[key] = connectTool(conn.name);
        const authed = isOAuthMcp
          ? await oauthFor(conn.name)
              .isAuthorized(principal)
              .catch(() => false)
          : await oauth2FlowFor(conn.name)
              .isAuthorized(principal)
              .catch(() => false);
        if (!authed) toolApproval[key] = "user-approval";
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
    // The full principal flows through; grant storage maps to the acting human
    // inside grantVault, so a channel connect card completes for the person
    // who clicked it — never onto the binding owner's key — while config keeps
    // the binding's view of the connection.
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
      // An oauth2 grant check reads the connection's client secret, so a deleted
      // one throws here. This listing backs the whole Connections page — one
      // revoked connection reports as unauthorized, it doesn't blank the page.
      const grantOk = (check: Promise<boolean>) => check.catch(() => false);
      for (const c of conns) {
        if (c.kind === "mcp") {
          const isOAuth = c.auth?.kind === "oauth";
          out.push({
            name: c.name,
            oauth: isOAuth,
            authorized: isOAuth ? await grantOk(oauthFor(c.name).isAuthorized(principal)) : true,
          });
        } else if (c.auth?.kind === "oauth2") {
          out.push({
            name: c.name,
            oauth: true,
            authorized: await grantOk(oauth2FlowFor(c.name).isAuthorized(principal)),
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
