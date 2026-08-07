import {
  auth,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthClientInformation,
  type OAuthAuthorizationServerInformation,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { Vault } from "@intentface/latch-core";
import type { FetchFunction } from "./oauth-fetch.js";

/**
 * MCP OAuth (Authorization Code + PKCE), Vault-backed and per-tenant.
 *
 * The consent step is a browser redirect, so this is *chat-initiated,
 * browser-completed, callback-finalized*: `start()` returns the IdP URL to send
 * the user to; the host app's callback route calls `finish()` to exchange the
 * code for tokens. All flow state (tokens, PKCE verifier, CSRF state, DCR client
 * info) is stored in the Vault under the tenant's scope — never logged, never
 * sent to the model. An authorization-server allowlist stops a malicious MCP
 * server from pointing us at an attacker's IdP.
 */
export interface McpOAuthConfig<P = unknown> {
  /** Connection name — namespaces the Vault keys for this server. */
  name: string;
  /**
   * MCP server URL (the protected resource). A function defers the lookup to
   * flow time, per caller — used by UI-added connections whose URL lives in the
   * caller's Vault and isn't known when the OAuth client is constructed.
   */
  serverUrl: string | ((principal: P) => string | Promise<string>);
  /** Our callback URL, registered with the IdP. Must be exact. */
  redirectUrl: string;
  /** OAuth client metadata (DCR or pre-registered client). */
  clientMetadata: OAuthClientMetadata;
  /**
   * A pre-registered OAuth client. When this resolves to a value,
   * `clientInformation()` returns it and the SDK SKIPS Dynamic Client
   * Registration — required for auth servers without DCR (Google, etc.). A
   * function defers the lookup per caller (e.g. UI connections whose creds live
   * in the caller's Vault).
   */
  clientInformation?:
    | OAuthClientInformation
    | ((principal: P) => OAuthClientInformation | undefined | Promise<OAuthClientInformation | undefined>);
  /** Allowed OAuth authorization-server origins. Empty/undefined = allow any. */
  allowedAuthorizationServers?: string[];
  /**
   * Requested scope string, if the server expects one.
   *
   * A function defers the lookup to flow time, per caller — necessary, not
   * merely symmetric with `serverUrl`: a single `McpOAuth` instance is shared
   * across callers (UI connections are cached by connection NAME while the
   * connection record itself is per-caller), so a static string would request
   * one caller's scope on another caller's behalf. Resolve per principal and
   * that cannot happen.
   */
  scope?: string | ((principal: P) => string | undefined | Promise<string | undefined>);
  /**
   * Optionally validate/normalize the RFC 8707 resource URL discovered from the
   * server's metadata. Default (when omitted) requires an exact origin match;
   * override to tolerate e.g. a proxied http/https scheme difference. Return the
   * resource URL to use, or undefined to omit the resource parameter.
   */
  validateResourceURL?: (
    serverUrl: string | URL,
    resource?: string,
  ) => URL | undefined | Promise<URL | undefined>;
  /**
   * Custom fetch for the OAuth flow (discovery, token exchange, refresh). Use
   * `createOAuthDiscoveryFetch` to normalize a provider's non-conformant
   * discovery documents. Pass the SAME fetch to the host connection so the
   * transport's on-401 re-auth uses it too.
   */
  fetch?: FetchFunction;
}

const vaultKey = (name: string, part: string) => `mcp_oauth:${name}:${part}`;

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// --- state encoding ---------------------------------------------------------
// The OAuth `state` is `<csrf>.<payload>`: a random CSRF nonce, then optional
// base64url JSON carrying app context (which chat/approval to resume after the
// callback). The SDK round-trips the whole string and checks it against the
// stored value, so the payload is CSRF-protected too; we decode it on callback.

function b64urlEncode(json: unknown): string {
  const s = JSON.stringify(json);
  let bin = "";
  for (const ch of new TextEncoder().encode(s)) bin += String.fromCharCode(ch);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(part: string): unknown {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Decode the app payload baked into an OAuth `state` by `start({ state })`. */
export function decodeOAuthState(
  state: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!state) return undefined;
  const dot = state.indexOf(".");
  if (dot === -1) return undefined;
  try {
    const decoded = b64urlDecode(state.slice(dot + 1));
    return typeof decoded === "object" && decoded
      ? (decoded as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A Vault-backed `OAuthClientProvider` for one tenant + connection. Returned
 * alongside `takeAuthorizationUrl()`, which yields the URL captured during a
 * `REDIRECT` so the route can 302 the browser to it.
 */
export function createVaultOAuthProvider<P>(opts: {
  vault: Vault<P>;
  principal: P;
  config: McpOAuthConfig<P>;
  /** App context to bake into the OAuth `state` (recovered on callback). */
  stateData?: Record<string, unknown>;
}): { provider: OAuthClientProvider; takeAuthorizationUrl: () => URL | undefined } {
  const { vault, principal, config, stateData } = opts;
  const k = (part: string) => vaultKey(config.name, part);

  let captured: URL | undefined;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return config.redirectUrl;
    },
    get clientMetadata() {
      return config.clientMetadata;
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const raw = await vault.get(principal, k("tokens"));
      return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
    },
    async saveTokens(tokens) {
      await vault.set(principal, k("tokens"), JSON.stringify(tokens));
    },

    async saveCodeVerifier(verifier) {
      await vault.set(principal, k("verifier"), verifier);
    },
    async codeVerifier() {
      const v = await vault.get(principal, k("verifier"));
      if (!v) throw new Error(`MCP OAuth "${config.name}": missing PKCE code verifier`);
      return v;
    },

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      // A pre-registered client (config) wins and skips DCR; else use the
      // DCR-registered client stored in the Vault.
      if (config.clientInformation) {
        const ci =
          typeof config.clientInformation === "function"
            ? await config.clientInformation(principal)
            : config.clientInformation;
        if (ci) return ci;
      }
      const raw = await vault.get(principal, k("client"));
      return raw ? (JSON.parse(raw) as OAuthClientInformation) : undefined;
    },
    async saveClientInformation(info) {
      await vault.set(principal, k("client"), JSON.stringify(info));
    },

    // Persist the authorization-server metadata discovered during `start` so the
    // callback's code exchange can read it back. Required for pre-registered
    // clients (DCR skipped): without these, the SDK would otherwise stash the AS
    // info onto the client record, which our config-provided `clientInformation`
    // shadows — leaving the exchange with no stored AS metadata.
    async authorizationServerInformation(): Promise<
      OAuthAuthorizationServerInformation | undefined
    > {
      const raw = await vault.get(principal, k("as_info"));
      return raw ? (JSON.parse(raw) as OAuthAuthorizationServerInformation) : undefined;
    },
    async saveAuthorizationServerInformation(info) {
      await vault.set(principal, k("as_info"), JSON.stringify(info));
    },

    state() {
      const csrf = randomState();
      return stateData && Object.keys(stateData).length > 0
        ? `${csrf}.${b64urlEncode(stateData)}`
        : csrf;
    },
    async saveState(state) {
      await vault.set(principal, k("state"), state);
    },
    async storedState() {
      return (await vault.get(principal, k("state"))) ?? undefined;
    },

    redirectToAuthorization(url) {
      captured = url; // the route reads this and issues the 302
    },

    // Passthrough: omitted → SDK default (exact origin match).
    validateResourceURL: config.validateResourceURL
      ? async (serverUrl, resource) =>
          config.validateResourceURL!(serverUrl, resource)
      : undefined,

    validateAuthorizationServerURL(serverUrl, authorizationServerUrl) {
      const allow = config.allowedAuthorizationServers;
      if (!allow || allow.length === 0) return; // not configured → allow
      const origin = new URL(authorizationServerUrl).origin;
      if (!allow.includes(origin)) {
        throw new Error(
          `MCP OAuth "${config.name}": authorization server ${origin} is not allowed`,
        );
      }
    },

    async invalidateCredentials(which) {
      const parts =
        which === "all"
          ? ["tokens", "verifier", "state", "client", "as_info"]
          : which === "tokens"
            ? ["tokens"]
            : which === "verifier"
              ? ["verifier"]
              : ["client"];
      await Promise.all(parts.map((p) => vault.delete(principal, k(p))));
    },
  };

  return { provider, takeAuthorizationUrl: () => captured };
}

export type StartResult =
  | { status: "redirect"; authorizationUrl: string }
  | { status: "authorized" };

export interface McpOAuth<P> {
  /** Whether this caller already holds tokens for the connection. */
  isAuthorized(principal: P): Promise<boolean>;
  /**
   * Begin the flow: returns the IdP URL to redirect to, or 'authorized' if
   * tokens already exist. `state` is app context (e.g. `{ chatId, approvalId }`)
   * baked into the OAuth state and recoverable on callback via `decodeOAuthState`.
   */
  start(principal: P, opts?: { state?: Record<string, unknown> }): Promise<StartResult>;
  /** Finalize on the callback: exchange the code for tokens (stored in the Vault). */
  finish(principal: P, params: { code: string; state?: string }): Promise<{ status: "authorized" }>;
  /** The Vault-backed provider for the *use* phase (auto-refreshes tokens). */
  provider(principal: P): OAuthClientProvider;
}

export function createMcpOAuth<P>(opts: {
  vault: Vault<P>;
  config: McpOAuthConfig<P>;
}): McpOAuth<P> {
  const { vault, config } = opts;
  const resolveServerUrl = (principal: P): string | Promise<string> =>
    typeof config.serverUrl === "function" ? config.serverUrl(principal) : config.serverUrl;
  const resolveScope = (principal: P): string | undefined | Promise<string | undefined> =>
    typeof config.scope === "function" ? config.scope(principal) : config.scope;
  return {
    async isAuthorized(principal) {
      return vault.has(principal, vaultKey(config.name, "tokens"));
    },

    async start(principal, opts) {
      const { provider, takeAuthorizationUrl } = createVaultOAuthProvider({
        vault,
        principal,
        config,
        stateData: opts?.state,
      });
      const result = await auth(provider, {
        serverUrl: await resolveServerUrl(principal),
        scope: await resolveScope(principal),
        fetchFn: config.fetch,
      });
      if (result === "AUTHORIZED") return { status: "authorized" };
      const url = takeAuthorizationUrl();
      if (!url) {
        throw new Error(
          `MCP OAuth "${config.name}": authorization required but no redirect URL was produced`,
        );
      }
      return { status: "redirect", authorizationUrl: url.toString() };
    },

    async finish(principal, params) {
      const { provider } = createVaultOAuthProvider({ vault, principal, config });
      await auth(provider, {
        serverUrl: await resolveServerUrl(principal),
        authorizationCode: params.code,
        callbackState: params.state,
        fetchFn: config.fetch,
      });
      return { status: "authorized" };
    },

    provider(principal) {
      return createVaultOAuthProvider({ vault, principal, config }).provider;
    },
  };
}
