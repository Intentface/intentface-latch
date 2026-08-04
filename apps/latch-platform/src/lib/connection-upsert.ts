import type { CredentialScope } from "./credentials";
import type { ConnectionStore, StoredConnection } from "./connection-store";
import type { DynamicConnections } from "./dynamic-connections";
import type { Principal } from "./session";
import { assertPublicHttpsUrl } from "./oauth2-flow";
import { parseScopes, sameScopeSet } from "./oauth-scopes";

/**
 * The editable shape of a connection — what the Connections page form posts and
 * what the Agent Builder's `create_connection` assembles. Secrets arrive here
 * ALREADY RESOLVED: the agent path passes vault-name refs and resolves them
 * before calling in, so this module never touches the Vault and stays a pure
 * validation + persistence unit.
 */
export interface ConnectionInput {
  name: string;
  kind: "mcp" | "openapi";
  scope: CredentialScope;
  url?: string;
  spec?: string;
  baseUrl?: string;
  operations?: string;
  /**
   * "oauth" (MCP only) uses the interactive discovery flow (no token);
   * "oauth2" (OpenAPI only) is a pre-registered client — requires the
   * authorizeUrl/tokenUrl/clientId/clientSecret fields; else token/none.
   */
  authMode?: "none" | "token" | "oauth" | "oauth2";
  authHeader?: string;
  token?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** oauth2: whitespace-separated scope items (a provider's own delimiter, e.g. Strava's commas, survives inside one item). */
  scopes?: string;
}

export type UpsertResult = { ok: true; name: string } | { ok: false; error: string };

/** Connection names are used as tool-source keys — keep them to a safe alphabet. */
export const normalizeConnectionName = (raw: string): string =>
  raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Create or update a connection. Shared by the Connections page
 * (`addConnectionFn`) and the Agent Builder (`create_connection`) so the two
 * can't drift on validation, SSRF checks, or the secret carry-over rule.
 *
 * The CALLER owns authorization — both paths gate `scope: "org"` behind
 * `isOrgAdmin` before getting here.
 */
export async function upsertConnection(
  principal: Principal,
  data: ConnectionInput,
  deps: { connectionStore: ConnectionStore; dynamic: DynamicConnections },
): Promise<UpsertResult> {
  const { connectionStore, dynamic } = deps;
  const name = normalizeConnectionName(data.name);
  if (!name) return { ok: false, error: "name required" };

  // Add is an upsert by (name, scope) — editing goes through here too. A
  // blank secret field on an existing connection means "keep the current
  // secret" (the edit form never sees stored secrets to send them back).
  const existing = (await connectionStore.list(principal)).find(
    (c) => c.name === name && c.scope === data.scope,
  );

  let auth: StoredConnection["auth"];
  if (data.authMode === "oauth2") {
    if (data.kind !== "openapi") {
      return { ok: false, error: "oauth2 is supported for OpenAPI connections only" };
    }
    const authorizeUrl = data.authorizeUrl?.trim();
    const tokenUrl = data.tokenUrl?.trim();
    const clientId = data.clientId?.trim();
    const clientSecret =
      data.clientSecret?.trim() ||
      (existing?.auth?.kind === "oauth2" ? existing.auth.clientSecret : undefined);
    if (!authorizeUrl || !tokenUrl || !clientId || !clientSecret) {
      return {
        ok: false,
        error: "oauth2 requires authorize URL, token URL, client ID and client secret",
      };
    }
    try {
      await assertPublicHttpsUrl(authorizeUrl);
      await assertPublicHttpsUrl(tokenUrl);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    auth = {
      kind: "oauth2",
      authorizeUrl,
      tokenUrl,
      clientId,
      clientSecret,
      scopes: parseScopes(data.scopes),
    };
  } else if (data.kind === "mcp" && data.authMode === "oauth") {
    auth = { kind: "oauth", scopes: parseScopes(data.scopes) };
  } else if (data.authMode === "none") {
    auth = undefined; // an explicit "none" clears auth even if a token was typed
  } else {
    // Blank token in token mode keeps the stored one (edit).
    const token =
      data.token?.trim() ||
      (data.authMode === "token" &&
      (existing?.auth?.kind === "bearer" || existing?.auth?.kind === "header")
        ? existing.auth.token
        : undefined);
    auth = token
      ? {
          kind: data.authHeader?.trim() ? "header" : "bearer",
          header: data.authHeader?.trim() || undefined,
          token,
        }
      : undefined;
  }

  if (data.kind === "mcp") {
    if (!data.url?.trim()) return { ok: false, error: "url required" };
    await connectionStore.add(principal, data.scope, {
      kind: "mcp",
      name,
      mcp: { url: data.url.trim() },
      auth,
    });
    // Requested scopes are baked into the issued token, so an existing token
    // keeps the OLD grant no matter what this record now says — a connection
    // could claim "private files only" while still holding an unrestricted
    // token, and a restriction scope can't be added by refresh (a refresh may
    // never widen a grant). Changing them therefore has to force a fresh
    // consent. Dropping the DCR client too, since it was registered under the
    // old scope.
    const before = existing?.auth?.kind === "oauth" ? existing.auth.scopes : undefined;
    const after = auth?.kind === "oauth" ? auth.scopes : undefined;
    // Set comparison, not positional: a scope is an unordered set, so
    // retyping the same permissions in a different order must not log the
    // user out of the connection.
    if (!sameScopeSet(before, after)) {
      try {
        await dynamic.oauth(name).provider(principal).invalidateCredentials?.("all");
      } catch (e) {
        // The record is already saved; a failed cleanup must not lose it. Log
        // loudly — a stale token here means the connection is less restricted
        // than the UI now claims, so it needs re-authorizing by hand.
        console.warn(`[connections] "${name}": clearing tokens after scope change failed:`, e);
      }
    }
  } else {
    if (!data.spec?.trim()) return { ok: false, error: "spec required" };
    const operations = data.operations
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await connectionStore.add(principal, data.scope, {
      kind: "openapi",
      name,
      openapi: {
        spec: data.spec.trim(),
        baseUrl: data.baseUrl?.trim() || undefined,
        operations: operations && operations.length > 0 ? operations : undefined,
      },
      auth,
    });
  }

  return { ok: true, name };
}
