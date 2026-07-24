import type { Vault } from "@intentface/latch-core";
import type {
  ConnectionStatus,
  McpConnections,
  McpOAuth,
  StartResult,
} from "@intentface/latch-mcp";
import { googleWriteTools } from "./google-workspace-tools";

/**
 * Google Workspace OAuth for the mirage sandbox and its write companion.
 *
 * Two connections share one pre-registered Google OAuth client but hold
 * SEPARATE grants (separate refresh tokens, separate consent):
 *
 * - `google_workspace` — read-only, NO tools. The mount IS the interface:
 *   once a user authorizes, their per-chat mirage workspace gains `/gdrive`,
 *   `/gmail`, `/gdocs`, `/gsheets` and `/gslides`. Only `*.readonly` scopes
 *   are ever requested, so even a compromised mount cannot write.
 *
 * - `google_workspace_write` — the draft-and-apply side. Contributes the
 *   approval-gated write tools (gmail_send; gdocs/gsheets/gslides create +
 *   append) with the narrowest scopes that allow them (send-only for Gmail;
 *   Docs/Sheets/Slides have no write-only scopes). Because it is a separate
 *   grant, the read-only token mirage holds never gains write power, and
 *   users who never connect it can't have agents write anything.
 *
 * Neither is an MCP connection (Google's Workspace MCP servers are gated
 * behind the Developer Preview); both broker plain Google REST OAuth:
 * authorize URL → handler callback → code exchange → refresh token in the
 * Vault, keyed per tenant (`[orgId, userId]` scope, so every user acts as
 * THEMSELVES — never someone else).
 *
 * Read-only vs write is enforced at the CONSENT level (the same scope-level
 * pattern as the Slack mount's public-channels-only rule): keep the read
 * connection's scopes `*.readonly`, and keep the write connection's scopes to
 * the narrowest verbs its tools implement.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface StoredTokens {
  refresh_token: string;
  access_token?: string;
  /** Epoch ms when access_token expires. */
  expires_at?: number;
}

/** Credentials the mirage session needs to mount the read-only services. */
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

interface GoogleOAuthCoreOpts<P> {
  vault: Vault<P>;
  clientId: string;
  clientSecret: string;
  /** e.g. `${baseUrl}/api/latch/connections` — `/<name>/callback` is appended. */
  callbackBaseUrl: string;
  /** Connection name — namespaces the Vault keys and the callback route. */
  name: string;
  scopes: string[];
}

/**
 * The shared OAuth plumbing: consent URL, CSRF state, code exchange, token
 * storage, refresh, and disconnect. Each connection gets its own instance
 * (own Vault namespace, own scopes, own callback route).
 */
function createGoogleOAuthCore<P>(opts: GoogleOAuthCoreOpts<P>) {
  const { vault, clientId, clientSecret, name } = opts;
  const redirectUri = `${opts.callbackBaseUrl}/${name}/callback`;
  const vaultKey = (part: string) => `google_oauth:${name}:${part}`;

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

  /** A live access token for the tenant, or throw when not connected. */
  const accessTokenFor = async (principal: P): Promise<string> => {
    const tokens = await readTokens(principal);
    if (!tokens?.refresh_token) {
      throw new Error(`"${name}" is not connected — connect it on the Connections page.`);
    }
    const data = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    return data.access_token;
  };

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
        scope: opts.scopes.join(" "),
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

    // Not an MCP connection, so no real OAuthClientProvider exists. The only
    // provider capability the platform calls outside the MCP client is
    // `invalidateCredentials` (the disconnect route) — implement exactly that:
    // best-effort revoke at Google, then drop the Vault entries.
    provider(principal) {
      const stub = {
        invalidateCredentials: async (_scope: string) => {
          const tokens = await readTokens(principal);
          if (tokens?.refresh_token) {
            await fetch(REVOKE_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: tokens.refresh_token }),
            }).catch(() => {}); // revocation is hygiene, not a precondition
          }
          await vault.delete(principal, vaultKey("tokens"));
          await vault.delete(principal, vaultKey("csrf"));
        },
      };
      return stub as unknown as ReturnType<McpOAuth<P>["provider"]>;
    },
  };

  return { oauth, readTokens, exchange, accessTokenFor };
}

// ---------------------------------------------------------------------------
// google_workspace — read-only mounts, no tools
// ---------------------------------------------------------------------------

const READ_NAME = "google_workspace";
const READ_DESCRIPTION =
  "Google Drive, Gmail, Docs, Sheets + Slides, read-only — files for the mirage " +
  "sandbox (/gdrive, /gmail, /gdocs, /gsheets, /gslides).";
const READ_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/presentations.readonly",
];

export interface GoogleConnectionOpts<P> {
  vault: Vault<P>;
  clientId: string;
  clientSecret: string;
  /** e.g. `${baseUrl}/api/latch/connections` — `/<name>/callback` is appended. */
  callbackBaseUrl: string;
}

export function createGoogleWorkspaceConnection<P>(
  opts: GoogleConnectionOpts<P>,
): McpConnections<P> & {
  /** Names owned by this registry (for latch.ts merge plumbing). */
  names: string[];
  /** Mount credentials for a tenant, or null when they haven't authorized. */
  mountCredsFor(principal: P): Promise<GoogleMountCreds | null>;
} {
  const core = createGoogleOAuthCore({ ...opts, name: READ_NAME, scopes: READ_SCOPES });

  const emptySource = {
    open: async () => ({ tools: {}, close: async () => {} }),
  };

  return {
    host: emptySource,
    hostFor: () => emptySource,
    names: [READ_NAME],
    oauth: (name) => (name === READ_NAME ? core.oauth : undefined),

    async status(principal): Promise<ConnectionStatus[]> {
      return [
        {
          name: READ_NAME,
          description: READ_DESCRIPTION,
          oauth: true,
          authorized: await core.oauth.isAuthorized(principal),
        },
      ];
    },

    // Connectivity probe: a refresh-grant round trip proves the stored token
    // still works. There are no tools — report the mounts instead, so the
    // Connections page's Test shows what this connection actually provides.
    async testTools(name, principal) {
      if (name !== READ_NAME) return [];
      await core.accessTokenFor(principal);
      return [
        "mirage sandbox mount: /gdrive (Drive, read-only)",
        "mirage sandbox mount: /gmail (Gmail, read-only)",
        "mirage sandbox mount: /gdocs (Docs, read-only)",
        "mirage sandbox mount: /gsheets (Sheets, read-only)",
        "mirage sandbox mount: /gslides (Slides, read-only)",
      ];
    },

    async mountCredsFor(principal): Promise<GoogleMountCreds | null> {
      const tokens = await core.readTokens(principal);
      if (!tokens?.refresh_token) return null;
      return {
        clientId: opts.clientId,
        refreshToken: tokens.refresh_token,
        refreshFn: async (refreshToken) => {
          const data = await core.exchange({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          });
          return { accessToken: data.access_token, expiresIn: data.expires_in };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// google_workspace_write — approval-gated write tools (draft-and-apply)
// ---------------------------------------------------------------------------

const WRITE_NAME = "google_workspace_write";
const WRITE_DESCRIPTION =
  "Google Workspace write actions (send email; create/append Docs, Sheets, " +
  "Slides) — approval-gated tools; separate consent from the read-only mounts.";
// No write-only scopes exist for Docs/Sheets/Slides — full RW is the
// narrowest grant that can create/append. Gmail keeps send-only.
const WRITE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
];

export function createGoogleWorkspaceWriteConnection<P>(
  opts: GoogleConnectionOpts<P>,
): McpConnections<P> & { names: string[] } {
  const core = createGoogleOAuthCore({ ...opts, name: WRITE_NAME, scopes: WRITE_SCOPES });

  // Tool definitions + the draft-and-apply contract live in
  // google-workspace-tools.ts. Built per open(principal) so the tenant is
  // bound in closure — the source is opened fresh each turn. EVERY tool is
  // gated by default (the agent editor can still surface/override that).
  const sourceFor = (principal: P) => {
    const tools = googleWriteTools(() => core.accessTokenFor(principal));
    return {
      tools,
      toolApproval: Object.fromEntries(Object.keys(tools).map((k) => [k, "user-approval"])),
      close: async () => {},
    };
  };

  const emptySource = {
    open: async () => ({ tools: {}, close: async () => {} }),
  };

  return {
    host: { open: async (principal: P) => sourceFor(principal) },
    hostFor: (names) =>
      names.includes(WRITE_NAME)
        ? { open: async (principal: P) => sourceFor(principal) }
        : emptySource,
    names: [WRITE_NAME],
    oauth: (name) => (name === WRITE_NAME ? core.oauth : undefined),

    async status(principal): Promise<ConnectionStatus[]> {
      return [
        {
          name: WRITE_NAME,
          description: WRITE_DESCRIPTION,
          oauth: true,
          authorized: await core.oauth.isAuthorized(principal),
        },
      ];
    },

    async testTools(name, principal) {
      if (name !== WRITE_NAME) return [];
      await core.accessTokenFor(principal); // refresh-grant connectivity probe
      return [
        "gmail_send (send email — approval-gated)",
        "gdocs_create / gdocs_append (Docs — approval-gated)",
        "gsheets_create / gsheets_append (Sheets — approval-gated)",
        "gslides_create (Slides — approval-gated)",
      ];
    },
  };
}
