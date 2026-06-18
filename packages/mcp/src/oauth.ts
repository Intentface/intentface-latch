import {
  auth,
  type OAuthClientProvider,
  type OAuthClientMetadata,
  type OAuthClientInformation,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { Scope, Vault } from "@intentface/latch-core";

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
export interface McpOAuthConfig {
  /** Connection name — namespaces the Vault keys for this server. */
  name: string;
  /** MCP server URL (the protected resource). */
  serverUrl: string;
  /** Our callback URL, registered with the IdP. Must be exact. */
  redirectUrl: string;
  /** OAuth client metadata (DCR or pre-registered client). */
  clientMetadata: OAuthClientMetadata;
  /** Allowed OAuth authorization-server origins. Empty/undefined = allow any. */
  allowedAuthorizationServers?: string[];
  /** Requested scope string, if the server expects one. */
  scope?: string;
}

const vaultKey = (name: string, part: string) => `mcp_oauth:${name}:${part}`;

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * A Vault-backed `OAuthClientProvider` for one tenant + connection. Returned
 * alongside `takeAuthorizationUrl()`, which yields the URL captured during a
 * `REDIRECT` so the route can 302 the browser to it.
 */
export function createVaultOAuthProvider(opts: {
  vault: Vault;
  scope: Scope;
  config: McpOAuthConfig;
}): { provider: OAuthClientProvider; takeAuthorizationUrl: () => URL | undefined } {
  const { vault, scope, config } = opts;
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
      const raw = await vault.get(scope, k("tokens"));
      return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
    },
    async saveTokens(tokens) {
      await vault.set(scope, k("tokens"), JSON.stringify(tokens));
    },

    async saveCodeVerifier(verifier) {
      await vault.set(scope, k("verifier"), verifier);
    },
    async codeVerifier() {
      const v = await vault.get(scope, k("verifier"));
      if (!v) throw new Error(`MCP OAuth "${config.name}": missing PKCE code verifier`);
      return v;
    },

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      const raw = await vault.get(scope, k("client"));
      return raw ? (JSON.parse(raw) as OAuthClientInformation) : undefined;
    },
    async saveClientInformation(info) {
      await vault.set(scope, k("client"), JSON.stringify(info));
    },

    state() {
      return randomState();
    },
    async saveState(state) {
      await vault.set(scope, k("state"), state);
    },
    async storedState() {
      return (await vault.get(scope, k("state"))) ?? undefined;
    },

    redirectToAuthorization(url) {
      captured = url; // the route reads this and issues the 302
    },

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
          ? ["tokens", "verifier", "state", "client"]
          : which === "tokens"
            ? ["tokens"]
            : which === "verifier"
              ? ["verifier"]
              : ["client"];
      await Promise.all(parts.map((p) => vault.delete(scope, k(p))));
    },
  };

  return { provider, takeAuthorizationUrl: () => captured };
}

export type StartResult =
  | { status: "redirect"; authorizationUrl: string }
  | { status: "authorized" };

export interface McpOAuth {
  /** Whether this tenant already holds tokens for the connection. */
  isAuthorized(scope: Scope): Promise<boolean>;
  /** Begin the flow: returns the IdP URL to redirect to, or 'authorized' if tokens exist. */
  start(scope: Scope): Promise<StartResult>;
  /** Finalize on the callback: exchange the code for tokens (stored in the Vault). */
  finish(scope: Scope, params: { code: string; state?: string }): Promise<{ status: "authorized" }>;
  /** The Vault-backed provider for the *use* phase (auto-refreshes tokens). */
  provider(scope: Scope): OAuthClientProvider;
}

export function createMcpOAuth(opts: {
  vault: Vault;
  config: McpOAuthConfig;
}): McpOAuth {
  const { vault, config } = opts;
  return {
    async isAuthorized(scope) {
      return vault.has(scope, vaultKey(config.name, "tokens"));
    },

    async start(scope) {
      const { provider, takeAuthorizationUrl } = createVaultOAuthProvider({
        vault,
        scope,
        config,
      });
      const result = await auth(provider, {
        serverUrl: config.serverUrl,
        scope: config.scope,
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

    async finish(scope, params) {
      const { provider } = createVaultOAuthProvider({ vault, scope, config });
      await auth(provider, {
        serverUrl: config.serverUrl,
        authorizationCode: params.code,
        callbackState: params.state,
      });
      return { status: "authorized" };
    },

    provider(scope) {
      return createVaultOAuthProvider({ vault, scope, config }).provider;
    },
  };
}
