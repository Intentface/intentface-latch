import { createHash } from "node:crypto";
import type { Vault } from "@intentface/latch-core";
import type { McpOAuth, StartResult } from "@intentface/latch-mcp";
import { isBlockedHost, isBlockedResolved } from "@intentface/latch-net";

/**
 * Generic OAuth2 authorization-code flow for a PRE-REGISTERED client with
 * explicit endpoints — no discovery, no dynamic client registration. This is
 * what UI-added `oauth2` connections (plain REST APIs: Strava, Fitbit, …) run
 * on. It implements the same `McpOAuth` shape the handler's authorize/callback/
 * disconnect routes and the gated `connect_<name>` tool already speak, so those
 * work unchanged; `accessTokenFor` is the extra surface the OpenAPI `bearer`
 * resolver pulls per tool call.
 *
 * Differences from the Google-specific core it generalizes (google-workspace.ts):
 * - PKCE (S256) on every authorize — servers that don't support it must ignore it.
 * - `expires_at`-aware caching: the access token is reused until near expiry
 *   instead of refreshing on every call.
 * - Refresh-token ROTATION: providers like Strava return a new refresh token on
 *   every refresh; the rotated token is persisted before the refresh resolves.
 * - Single-flight refresh per (owner, connection): with rotation, two
 *   concurrent refreshes using the same token permanently kill the grant.
 * - `refresh_token` is optional — some providers issue long-lived access
 *   tokens only.
 */
export interface OAuth2Endpoints {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /**
   * Extra identity folded into the grant fingerprint (e.g. the API target the
   * bearer token will be sent to). Changing it invalidates stored grants.
   */
  fingerprint?: string;
}

/**
 * Identity of the config a grant was minted for. Stored inside the token blob
 * and compared on every read: when a connection is reconfigured (endpoints,
 * client, scopes, target), grants minted for the OLD config are dropped
 * instead of reused — an old bearer token must never be sent to a newly
 * configured API, and an old client's refresh token is useless to a new one.
 * The client secret is deliberately excluded so a secret rotation on the SAME
 * client keeps existing grants.
 */
export function oauth2ConfigFingerprint(cfg: OAuth2Endpoints): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        cfg.authorizeUrl,
        cfg.tokenUrl,
        cfg.clientId,
        cfg.scopes ?? null,
        cfg.fingerprint ?? null,
      ]),
    )
    .digest("hex");
}

export interface OAuth2Flow<TPrincipal> extends McpOAuth<TPrincipal> {
  /** A live access token for the caller, refreshing if needed; throws when not connected. */
  accessTokenFor: (principal: TPrincipal) => Promise<string>;
}

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when access_token expires; absent = no known expiry. */
  expires_at?: number;
  /** Fingerprint of the connection config this grant was minted for. */
  cfg?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

/** Refresh this many ms before the recorded expiry (clock-skew headroom). */
const EXPIRY_SKEW_MS = 60_000;

const b64url = (json: unknown): string =>
  Buffer.from(JSON.stringify(json)).toString("base64url");

const randomHex = (bytes: number): string => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Reject a URL unless it is https and points at a public host — the shared
 * guard for user-supplied authorize/token endpoints, applied both when a
 * connection is saved and again before every token POST (DNS can drift after
 * save-time validation).
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`OAuth endpoints must be https: ${raw}`);
  }
  if (isBlockedHost(url.hostname) || (await isBlockedResolved(url.hostname))) {
    throw new Error(`OAuth endpoint host resolves to a private/internal address: ${url.hostname}`);
  }
  return url;
}

export function createOAuth2Flow<TPrincipal>(opts: {
  vault: Vault<TPrincipal>;
  /** Connection name — namespaces the Vault keys and the callback route. */
  name: string;
  /** e.g. `${baseUrl}/api/latch/connections` — `/<name>/callback` is appended. */
  callbackBaseUrl: string;
  /**
   * Endpoints + client credentials, re-read per use (they live in the caller's
   * stored connection) — re-adding a connection with new credentials needs no
   * cache invalidation here.
   */
  config: (principal: TPrincipal) => Promise<OAuth2Endpoints>;
  /** Stable caller identity for the single-flight refresh map. */
  ownerKey: (principal: TPrincipal) => string;
}): OAuth2Flow<TPrincipal> {
  const { vault, name } = opts;
  const redirectUri = `${opts.callbackBaseUrl.replace(/\/$/, "")}/${name}/callback`;
  const vaultKey = (part: string) => `oauth2:${name}:${part}`;

  const readTokens = async (principal: TPrincipal): Promise<StoredTokens | null> => {
    const raw = await vault.get(principal, vaultKey("tokens"));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  };

  /**
   * Stored tokens, validated against the CURRENT connection config — a grant
   * minted for a previous config (edited endpoints/client/target) is dropped
   * lazily here, flipping the connection back to "not connected".
   */
  const readValidTokens = async (principal: TPrincipal): Promise<StoredTokens | null> => {
    const tokens = await readTokens(principal);
    if (!tokens) return null;
    if (tokens.cfg !== oauth2ConfigFingerprint(await opts.config(principal))) {
      await vault.delete(principal, vaultKey("tokens"));
      return null;
    }
    return tokens;
  };

  const writeTokens = (principal: TPrincipal, tokens: StoredTokens) =>
    vault.set(principal, vaultKey("tokens"), JSON.stringify(tokens));

  const fresh = (tokens: StoredTokens): boolean =>
    tokens.expires_at == null || Date.now() < tokens.expires_at - EXPIRY_SKEW_MS;

  const notConnected = () =>
    new Error(`"${name}" is not connected — connect it on the Connections page.`);

  /** POST the token endpoint (authorization_code or refresh_token grant). */
  async function exchange(
    principal: TPrincipal,
    grant: Record<string, string>,
  ): Promise<TokenResponse> {
    const cfg = await opts.config(principal);
    // Re-validated on every POST, not just at save time (DNS drift).
    await assertPublicHttpsUrl(cfg.tokenUrl);
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        ...grant,
      }),
      // The SSRF guard above only vets the FIRST hop — following a redirect
      // would replay the client secret + refresh token to an unvetted (possibly
      // internal) address. And a hanging IdP must not pin the single-flight
      // refresh slot forever.
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text();
      // `invalid_grant` means the grant itself is dead (revoked/expired/rotated
      // away) — the caller uses this marker to drop the stored tokens. Other
      // failures (bad client secret, 5xx, network) must NOT kill the grant.
      const dead = body.includes("invalid_grant");
      const err = new Error(`oauth2 token endpoint ${res.status}: ${body}`);
      (err as Error & { grantDead?: boolean }).grantDead = dead;
      throw err;
    }
    return (await res.json()) as TokenResponse;
  }

  const stored = (data: TokenResponse, cfg: string, prevRefresh?: string): StoredTokens => ({
    access_token: data.access_token,
    // Rotation: keep the newest refresh token; fall back to the previous one
    // when the provider omits it from the response.
    refresh_token: data.refresh_token ?? prevRefresh,
    expires_at: data.expires_in != null ? Date.now() + data.expires_in * 1000 : undefined,
    cfg,
  });

  // Single-flight refresh per caller: with rotating refresh tokens (Strava),
  // two concurrent refreshes with the same token brick the grant. In-process
  // only — cross-instance races are mitigated by re-reading the Vault inside
  // the flight (a parallel instance's rotation is picked up, not refreshed over).
  const inflight = new Map<string, Promise<string>>();

  async function refreshLocked(principal: TPrincipal, retried = false): Promise<string> {
    const tokens = await readValidTokens(principal); // re-read: another flight may have rotated
    if (!tokens) throw notConnected();
    if (fresh(tokens)) return tokens.access_token;
    if (!tokens.refresh_token) {
      await vault.delete(principal, vaultKey("tokens"));
      throw notConnected();
    }
    let data: TokenResponse;
    try {
      data = await exchange(principal, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      });
    } catch (err) {
      if ((err as Error & { grantDead?: boolean }).grantDead) {
        // Compare-and-delete: with rotation, invalid_grant can mean ANOTHER
        // INSTANCE won the refresh race and our token is merely stale — never
        // delete a grant someone else just rotated. Only kill it when the
        // stored refresh token is still the one that failed; otherwise retry
        // once against the rotated grant.
        const current = await readTokens(principal);
        if (current && current.refresh_token !== tokens.refresh_token && !retried) {
          return refreshLocked(principal, true);
        }
        await vault.delete(principal, vaultKey("tokens"));
        throw notConnected();
      }
      throw err; // transient — keep the stored tokens
    }
    // Persist (incl. the rotated refresh token) BEFORE resolving: a waiter
    // released earlier could start a second refresh with the dead old token.
    const cfg = oauth2ConfigFingerprint(await opts.config(principal));
    await writeTokens(principal, stored(data, cfg, tokens.refresh_token));
    return data.access_token;
  }

  const accessTokenFor = async (principal: TPrincipal): Promise<string> => {
    const tokens = await readValidTokens(principal);
    if (!tokens) throw notConnected();
    if (fresh(tokens)) return tokens.access_token;
    const key = opts.ownerKey(principal);
    let flight = inflight.get(key);
    if (!flight) {
      flight = refreshLocked(principal).finally(() => inflight.delete(key));
      inflight.set(key, flight);
    }
    return flight;
  };

  const oauth: OAuth2Flow<TPrincipal> = {
    accessTokenFor,

    async isAuthorized(principal) {
      const tokens = await readValidTokens(principal);
      if (!tokens) return false;
      return tokens.refresh_token != null || fresh(tokens);
    },

    async start(principal, startOpts): Promise<StartResult> {
      if (await oauth.isAuthorized(principal)) return { status: "authorized" };
      const cfg = await opts.config(principal);
      const authorizeUrl = await assertPublicHttpsUrl(cfg.authorizeUrl);
      const csrf = randomHex(16);
      await vault.set(principal, vaultKey("csrf"), csrf);
      // PKCE S256 — always sent; servers without PKCE support must ignore it.
      const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      );
      await vault.set(principal, vaultKey("verifier"), verifier);
      const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ).toString("base64url");
      // Same `<csrf>.<b64url(payload)>` format as latch-mcp's flows, so the
      // handler's `decodeOAuthState` (returnTo, chat resume) works on our
      // callbacks too.
      const state = `${csrf}.${b64url(startOpts?.state ?? {})}`;
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      if (cfg.scopes?.length) params.set("scope", cfg.scopes.join(" "));
      // MERGE into the configured query — providers hang required parameters
      // off the authorize URL (Auth0's audience, Google's access_type/prompt)
      // and replacing the query would drop them. Ours win on a name clash.
      for (const [k, v] of params) authorizeUrl.searchParams.set(k, v);
      return { status: "redirect", authorizationUrl: authorizeUrl.toString() };
    },

    async finish(principal, params) {
      const csrf = await vault.get(principal, vaultKey("csrf"));
      const got = params.state?.split(".")[0];
      if (!csrf || !got || got !== csrf) throw new Error("OAuth state mismatch");
      await vault.delete(principal, vaultKey("csrf"));
      const verifier = await vault.get(principal, vaultKey("verifier"));
      await vault.delete(principal, vaultKey("verifier"));
      const data = await exchange(principal, {
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: redirectUri,
        ...(verifier ? { code_verifier: verifier } : {}),
      });
      if (!data.access_token) {
        throw new Error(`"${name}" token endpoint returned no access token`);
      }
      const cfg = oauth2ConfigFingerprint(await opts.config(principal));
      await writeTokens(principal, stored(data, cfg));
      return { status: "authorized" };
    },

    // Not an MCP connection, so no real OAuthClientProvider exists. The only
    // provider capability the platform calls outside the MCP client is
    // `invalidateCredentials` (the disconnect route) — implement exactly that.
    provider(principal) {
      const stub = {
        invalidateCredentials: async (_scope: string) => {
          await vault.delete(principal, vaultKey("tokens"));
          await vault.delete(principal, vaultKey("csrf"));
          await vault.delete(principal, vaultKey("verifier"));
        },
      };
      return stub as unknown as ReturnType<McpOAuth<TPrincipal>["provider"]>;
    },
  };

  return oauth;
}
