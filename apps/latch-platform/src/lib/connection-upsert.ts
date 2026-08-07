import type { CredentialScope } from "./credentials";
import type { ConnectionStore, StoredConnection } from "./connection-store";
import type { DynamicConnections } from "./dynamic-connections";
import type { NamedSecrets } from "./named-secrets";
import type { Principal } from "./session";
import { assertSecretRef, defaultSecretName, normalizeSecretName } from "./named-secrets";
import { assertPublicHttpsUrl } from "./oauth2-flow";
import { parseScopes, sameScopeSet } from "./oauth-scopes";

/**
 * The editable shape of a connection — what the Connections page form posts and
 * what the Agent Builder's `create_connection` assembles.
 *
 * The two paths differ in how the credential arrives: the form posts a VALUE the
 * user typed, the agent passes only a NAME (it must never hold a value). Both
 * converge on a name — a typed value is minted into a named secret here — so a
 * connection always ends up storing a reference, never a copy.
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
  /** A static token the user TYPED. Minted into a named secret; never stored as-is. */
  token?: string;
  /** The name of an existing secret to use as the static token (the agent's path). */
  tokenRef?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  /** An oauth2 client secret the user TYPED. Minted into a named secret. */
  clientSecret?: string;
  /** The name of an existing secret to use as the oauth2 client secret. */
  clientSecretRef?: string;
  /** oauth2: whitespace-separated scope items (a provider's own delimiter, e.g. Strava's commas, survives inside one item). */
  scopes?: string;
}

export type UpsertResult = { ok: true; name: string } | { ok: false; error: string };

/** Connection names are used as tool-source keys — keep them to a safe alphabet. */
export const normalizeConnectionName = (raw: string): string =>
  raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

/** What a connection ends up pointing at for one credential field. */
type SettledSecret =
  | { ok: true; ref?: string; inline?: string }
  | { ok: false; error: string };

/**
 * Decide which named secret backs one credential field, minting one if the user
 * typed a value. Precedence, highest first:
 *
 * 1. A ref the caller named — validated against the connection's own scope.
 * 2. A value the user typed — stored under this connection's own secret name,
 *    which is also how a legacy inline secret finally becomes a reference.
 * 3. Neither: keep what the record already used (the blank-field convention).
 *    A legacy inline value survives untouched until someone retypes it.
 */
async function settleSecret(opts: {
  secrets: NamedSecrets;
  principal: Principal;
  scope: CredentialScope;
  connection: string;
  field: "token" | "client_secret";
  ref?: string;
  typed?: string;
  existingRef?: string;
  existingInline?: string;
}): Promise<SettledSecret> {
  const { secrets, principal, scope, connection, field, existingRef, existingInline } = opts;

  const ref = opts.ref?.trim();
  if (ref) {
    const checked = await assertSecretRef(secrets, principal, ref, scope, `${field}Ref`);
    if (!checked.ok) return checked;
    return { ok: true, ref: normalizeSecretName(ref) };
  }

  const typed = opts.typed?.trim();
  if (typed) {
    // Retyping rotates the secret already in use, in place — every other
    // connection pointing at that name gets the new value too, which is the
    // whole point of references. Only a connection with no ref yet needs a name.
    let name = existingRef;
    if (!name) {
      const derived = defaultSecretName(connection, field);
      name = derived;
      // The derived name can already belong to something else (a secret the
      // agent minted, another connection's). Never silently overwrite it.
      for (let i = 2; (await secrets.has(principal, name, scope)) && i < 100; i++) {
        name = `${derived}-${i}`;
      }
      if (await secrets.has(principal, name, scope)) {
        return { ok: false, error: `Could not find a free secret name for "${derived}".` };
      }
    }
    await secrets.set(principal, name, scope, typed);
    return { ok: true, ref: name };
  }

  return { ok: true, ref: existingRef, inline: existingRef ? undefined : existingInline };
}

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
  deps: {
    connectionStore: ConnectionStore;
    dynamic: DynamicConnections;
    namedSecrets: NamedSecrets;
  },
): Promise<UpsertResult> {
  const { connectionStore, dynamic, namedSecrets } = deps;
  const name = normalizeConnectionName(data.name);
  if (!name) return { ok: false, error: "name required" };

  // The kind's own target, validated before anything is written: settling a
  // secret can MINT one, so a late "spec required" would leave an orphan
  // credential behind. Bound here so the write below needs no re-checking.
  let mcpUrl = "";
  let openapiSpec = "";
  if (data.kind === "mcp") {
    mcpUrl = data.url?.trim() ?? "";
    if (!mcpUrl) return { ok: false, error: "url required" };
  } else {
    openapiSpec = data.spec?.trim() ?? "";
    if (!openapiSpec) return { ok: false, error: "spec required" };
  }

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
    if (!authorizeUrl || !tokenUrl || !clientId) {
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
    const prev = existing?.auth?.kind === "oauth2" ? existing.auth : undefined;
    const secret = await settleSecret({
      secrets: namedSecrets,
      principal,
      scope: data.scope,
      connection: name,
      field: "client_secret",
      ref: data.clientSecretRef,
      typed: data.clientSecret,
      existingRef: prev?.clientSecretRef,
      existingInline: prev?.clientSecret,
    });
    if (!secret.ok) return secret;
    if (!secret.ref && !secret.inline) {
      return {
        ok: false,
        error: "oauth2 requires authorize URL, token URL, client ID and client secret",
      };
    }
    auth = {
      kind: "oauth2",
      authorizeUrl,
      tokenUrl,
      clientId,
      clientSecret: secret.inline,
      clientSecretRef: secret.ref,
      scopes: parseScopes(data.scopes),
    };
  } else if (data.authMode === "oauth") {
    // The mirror of the oauth2-on-MCP rejection above. Without it an OpenAPI
    // connection asking for "oauth" falls through to the static-token branch,
    // finds no token, and saves with NO auth at all — a silently unauthenticated
    // connection that looks configured. OpenAPI's interactive flow is "oauth2".
    if (data.kind !== "openapi") {
      auth = { kind: "oauth", scopes: parseScopes(data.scopes) };
    } else {
      return {
        ok: false,
        error: "oauth (discovery) is supported for MCP connections only — use oauth2 for OpenAPI",
      };
    }
  } else if (data.authMode === "none") {
    auth = undefined; // an explicit "none" clears auth even if a token was typed
  } else {
    // Blank token in token mode keeps the stored one (edit).
    const prev =
      data.authMode === "token" &&
      (existing?.auth?.kind === "bearer" || existing?.auth?.kind === "header")
        ? existing.auth
        : undefined;
    const secret = await settleSecret({
      secrets: namedSecrets,
      principal,
      scope: data.scope,
      connection: name,
      field: "token",
      ref: data.tokenRef,
      typed: data.token,
      existingRef: prev?.tokenRef,
      existingInline: prev?.token,
    });
    if (!secret.ok) return secret;
    auth =
      secret.ref || secret.inline
        ? {
            kind: data.authHeader?.trim() ? "header" : "bearer",
            header: data.authHeader?.trim() || undefined,
            token: secret.inline,
            tokenRef: secret.ref,
          }
        : undefined;
  }

  if (data.kind === "mcp") {
    await connectionStore.add(principal, data.scope, {
      kind: "mcp",
      name,
      mcp: { url: mcpUrl },
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
    const operations = data.operations
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await connectionStore.add(principal, data.scope, {
      kind: "openapi",
      name,
      openapi: {
        spec: openapiSpec,
        baseUrl: data.baseUrl?.trim() || undefined,
        operations: operations && operations.length > 0 ? operations : undefined,
      },
      auth,
    });
  }

  return { ok: true, name };
}
