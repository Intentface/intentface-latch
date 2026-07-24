import type { Vault } from "@intentface/latch-core";
import type {
  ConnectionStatus,
  McpConnections,
  McpOAuth,
  StartResult,
} from "@intentface/latch-mcp";

/**
 * Google Workspace OAuth for the mirage sandbox's read-only mounts — a
 * connection with NO tools. The mount IS the interface: once a user
 * authorizes, their per-chat mirage workspace gains `/gdrive`, `/gmail`,
 * `/gdocs`, `/gsheets` and `/gslides`.
 *
 * Not an MCP connection (Google's Workspace MCP servers are gated behind the
 * Developer Preview), and unlike an MCP connection it brokers plain Google
 * REST OAuth itself: authorize URL → handler callback → code exchange →
 * refresh token in the Vault, keyed per tenant (`[orgId, userId]` scope, so
 * every user mounts their OWN Drive/Gmail — never someone else's).
 *
 * Read-only is enforced at the CONSENT level: only `*.readonly` scopes
 * (drive, gmail, documents, spreadsheets, presentations) are ever requested,
 * so even a compromised mount cannot write — the same scope-level pattern as
 * the Slack mount's public-channels-only rule. Do not add write scopes here.
 *
 * Registered like any built-in connection (status list, authorize/callback
 * routes) via the same registry shape the MCP set uses; `hostFor` contributes
 * zero tools.
 */
const NAME = "google_workspace";
const DESCRIPTION =
  "Google Drive, Gmail, Docs, Sheets + Slides, read-only — files for the mirage " +
  "sandbox (/gdrive, /gmail, /gdocs, /gsheets, /gslides).";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const vaultKey = (part: string) => `google_oauth:${NAME}:${part}`;

interface StoredTokens {
  refresh_token: string;
  access_token?: string;
  /** Epoch ms when access_token expires. */
  expires_at?: number;
}

/** Credentials the mirage session needs to mount /gdrive and /gmail. */
export interface GoogleMountCreds {
  clientId: string;
  refreshToken: string;
  /** Server-side refresh — the client secret never leaves this module. */
  refreshFn: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>;
}

// --- OAuth state: `<csrf>.<b64url(JSON payload)>`, the same format
// latch-mcp's flows use so the handler's `decodeOAuthState` (returnTo, chat
// resume) keeps working on our callbacks.
const b64url = (json: unknown): string =>
  Buffer.from(JSON.stringify(json)).toString("base64url");

const randomHex = (bytes: number): string => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

export function createGoogleWorkspaceConnection<P>(opts: {
  vault: Vault<P>;
  clientId: string;
  clientSecret: string;
  /** e.g. `${baseUrl}/api/latch/connections` — `/<name>/callback` is appended. */
  callbackBaseUrl: string;
}): McpConnections<P> & {
  /** Names owned by this registry (for latch.ts merge plumbing). */
  names: string[];
  /** Mount credentials for a tenant, or null when they haven't authorized. */
  mountCredsFor(principal: P): Promise<GoogleMountCreds | null>;
} {
  const { vault, clientId, clientSecret } = opts;
  const redirectUri = `${opts.callbackBaseUrl}/${NAME}/callback`;

  const readTokens = async (principal: P): Promise<StoredTokens | null> => {
    const raw = await vault.get(principal, vaultKey("tokens"));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  };

  /** POST the token endpoint (authorization_code or refresh_token grant). */
  async function exchange(
    grant: Record<string, string>,
  ): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...grant,
      }),
    });
    if (!res.ok) {
      // Google error bodies name the cause (invalid_grant, redirect_uri
      // mismatch); keep it, but it never contains secrets.
      throw new Error(`google token endpoint ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
  }

  const oauth: McpOAuth<P> = {
    async isAuthorized(principal) {
      return (await readTokens(principal))?.refresh_token != null;
    },

    async start(principal, startOpts): Promise<StartResult> {
      const csrf = randomHex(16);
      await vault.set(principal, vaultKey("csrf"), csrf);
      const state = `${csrf}.${b64url(startOpts?.state ?? {})}`;
      const url = new URL(AUTH_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES.join(" "),
        // Offline + consent → Google issues a refresh token on every authorize.
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      return { status: "redirect", authorizationUrl: url.toString() };
    },

    async finish(principal, params) {
      const csrf = await vault.get(principal, vaultKey("csrf"));
      const got = params.state?.split(".")[0];
      if (!csrf || !got || got !== csrf) throw new Error("OAuth state mismatch");
      await vault.delete(principal, vaultKey("csrf"));
      const data = await exchange({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: redirectUri,
      });
      if (!data.refresh_token) {
        throw new Error("Google returned no refresh token — re-run the consent flow.");
      }
      const tokens: StoredTokens = {
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      await vault.set(principal, vaultKey("tokens"), JSON.stringify(tokens));
      return { status: "authorized" };
    },

    provider(): never {
      throw new Error(`${NAME} is not an MCP connection — no OAuth provider`);
    },
  };

  const emptySource = {
    open: async () => ({ tools: {}, close: async () => {} }),
  };

  return {
    host: emptySource,
    hostFor: () => emptySource,
    names: [NAME],
    oauth: (name) => (name === NAME ? oauth : undefined),

    async status(principal): Promise<ConnectionStatus[]> {
      return [
        {
          name: NAME,
          description: DESCRIPTION,
          oauth: true,
          authorized: await oauth.isAuthorized(principal),
        },
      ];
    },

    // Connectivity probe: a refresh-grant round trip proves the stored token
    // still works. There are no tools — report the mounts instead, so the
    // Connections page's Test shows what this connection actually provides.
    async testTools(name, principal) {
      if (name !== NAME) return [];
      const tokens = await readTokens(principal);
      if (!tokens) throw new Error(`"${NAME}" is not connected`);
      await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
      return [
        "mirage sandbox mount: /gdrive (Drive, read-only)",
        "mirage sandbox mount: /gmail (Gmail, read-only)",
        "mirage sandbox mount: /gdocs (Docs, read-only)",
        "mirage sandbox mount: /gsheets (Sheets, read-only)",
        "mirage sandbox mount: /gslides (Slides, read-only)",
      ];
    },

    async mountCredsFor(principal): Promise<GoogleMountCreds | null> {
      const tokens = await readTokens(principal);
      if (!tokens?.refresh_token) return null;
      return {
        clientId,
        refreshToken: tokens.refresh_token,
        refreshFn: async (refreshToken) => {
          const data = await exchange({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          });
          return { accessToken: data.access_token, expiresIn: data.expires_in };
        },
      };
    },
  };
}
