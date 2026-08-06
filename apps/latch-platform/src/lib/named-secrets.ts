import type { Vault } from "@intentface/latch-core";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";

/**
 * Named secrets — credentials the user types once and then refers to BY NAME.
 *
 * The Agent Builder can't be handed a client secret or an API key: anything in a
 * tool's input or output is model context. So the value is collected by the UI,
 * posted straight to the server, and stored here; the agent only ever learns the
 * NAME, which it passes to `create_connection` as a `*Ref`.
 *
 * The connection stores that NAME too. Nothing copies the value out: it is read
 * once per outgoing request, at egress (`dynamic-connections.ts`), so replacing
 * a secret rotates every connection built on it and deleting one revokes them.
 * The plaintext travels browser → server → Vault → the provider, and nowhere
 * else — never into a tool result, a message part, or the model's context.
 *
 * Same Vault, same owner-key isolation as {@link createCredentials}: a `"user"`
 * secret is stored at the caller's principal (owner `[org,user]`), an `"org"`
 * secret at a userId-stripped principal (owner `[org]`, shared org-wide).
 * Distinct key prefix so these never collide with the `conn:*:apikey` namespace
 * that channel credentials use.
 */
const PREFIX = "named_secret:";
const vaultKey = (name: string) => `${PREFIX}${name}`;
const ownerOf = (p: Principal, scope: CredentialScope): Principal =>
  scope === "org" ? { orgId: p.orgId } : p;

/** A stored secret's identity — never its value. */
export interface NamedSecretRef {
  name: string;
  scope: CredentialScope;
}

/**
 * The same sanitising `upsertConnection` applies to connection names, so a name
 * the agent proposes round-trips identically through the tool and the Secrets UI.
 */
export const normalizeSecretName = (raw: string): string =>
  raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_");

export function createNamedSecrets(vault: Vault<Principal>) {
  async function listAt(p: Principal, scope: CredentialScope): Promise<NamedSecretRef[]> {
    const keys = await vault.list(ownerOf(p, scope));
    return keys
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => ({ name: k.slice(PREFIX.length), scope }));
  }

  return {
    get: (p: Principal, name: string, scope: CredentialScope) =>
      vault.get(ownerOf(p, scope), vaultKey(name)),

    has: (p: Principal, name: string, scope: CredentialScope) =>
      vault.has(ownerOf(p, scope), vaultKey(name)),

    set: (p: Principal, name: string, scope: CredentialScope, value: string) =>
      vault.set(ownerOf(p, scope), vaultKey(name), value),

    remove: (p: Principal, name: string, scope: CredentialScope) =>
      vault.delete(ownerOf(p, scope), vaultKey(name)),

    /**
     * Every secret visible to the caller: org-shared + their personal ones.
     * Names and scopes ONLY — this is what the agent's `list_secrets` and the
     * Secrets UI both render, so it must never carry a value.
     */
    async list(p: Principal): Promise<NamedSecretRef[]> {
      const [org, user] = await Promise.all([listAt(p, "org"), listAt(p, "user")]);
      return [...org, ...user];
    },
  };
}

export type NamedSecrets = ReturnType<typeof createNamedSecrets>;

/**
 * The name a connection's own secret is minted under when the user types one
 * into the Connections form instead of naming an existing secret.
 *
 * Also the fingerprint stand-in for a legacy INLINE oauth2 client secret (see
 * `dynamic-connections.ts`): a connection's inline secret and the ref minted
 * from it on first retype are the same credential in two places, so both must
 * contribute the same identity or the migration would invalidate every grant.
 */
export const defaultSecretName = (
  connection: string,
  field: "token" | "client_secret",
): string => normalizeSecretName(`${connection}_${field}`);

/**
 * Check that a vault name the agent supplied exists at the scope its connection
 * will live at, WITHOUT reading the value. Connections store the name, not the
 * secret, so this is a validity check and nothing more — the plaintext is
 * fetched at egress by {@link requireSecret}.
 *
 * An absent ref is not an error: omitting it on an edit means "keep whatever
 * secret this connection already uses", matching the blank-field convention in
 * `upsertConnection`.
 */
export async function assertSecretRef(
  secrets: NamedSecrets,
  principal: Principal,
  ref: string | undefined,
  scope: CredentialScope,
  field: string,
): Promise<{ ok: true; name?: string } | { ok: false; error: string }> {
  if (!ref) return { ok: true };
  const name = normalizeSecretName(ref);
  // Strict scope match, both directions. A user-scoped secret must not back an
  // org-shared connection (every member would silently use one person's
  // credential), and an org secret must not be borrowed by a personal one.
  if (await secrets.has(principal, name, scope)) return { ok: true, name };
  // Naming the actual mistake beats a generic "not found": storing the secret
  // at the wrong scope is the common way this goes wrong, and the fix differs.
  const other: CredentialScope = scope === "org" ? "user" : "org";
  if (await secrets.has(principal, name, other)) {
    return {
      ok: false,
      error: `${field} "${name}" is stored at ${other} scope but this connection is ${scope}-scoped. Call request_secret again with scope "${scope}".`,
    };
  }
  return {
    ok: false,
    error: `No stored secret named "${name}". Call request_secret to have the user enter it first.`,
  };
}

/**
 * The plaintext behind a connection's `*Ref`, at the connection's own scope —
 * the one place a stored credential is read, on the way out to the provider.
 *
 * THROWS when the secret is gone. That is the point: deleting a secret has to
 * revoke the connections built on it, so the caller turns this into a contained
 * connection failure (zero tools + `onConnectionError`) rather than letting an
 * unauthenticated request leave the building and come back as a confusing 401.
 */
export async function requireSecret(
  secrets: NamedSecrets,
  principal: Principal,
  ref: string,
  scope: CredentialScope,
  connection: string,
): Promise<string> {
  const value = await secrets.get(principal, normalizeSecretName(ref), scope);
  if (!value) {
    throw new Error(
      `Connection "${connection}" needs the ${scope}-level secret "${ref}", which no longer exists. Re-add it on the Connections page.`,
    );
  }
  return value;
}
