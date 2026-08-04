import type { Vault } from "@intentface/latch-core";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";

/**
 * Named secrets — credentials the user types once and then refers to BY NAME.
 *
 * The Agent Builder can't be handed a client secret or an API key: anything in a
 * tool's input or output is model context. So the value is collected by the UI,
 * posted straight to the server, and stored here; the agent only ever learns the
 * NAME, which it passes to `create_connection` as a `*Ref`. The server resolves
 * the ref at write time (see `connection-upsert.ts`), so the plaintext travels
 * browser → server → Vault and nowhere else.
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
 * Turn a vault name the agent supplied into the plaintext a connection record
 * needs. The value is returned to the SERVER caller only — it goes straight
 * into the encrypted connection blob and never into a tool result.
 *
 * An absent ref is not an error: omitting it on an edit means "keep the stored
 * secret", matching the blank-field convention in `upsertConnection`.
 */
export async function resolveSecretRef(
  secrets: NamedSecrets,
  principal: Principal,
  ref: string | undefined,
  scope: CredentialScope,
  field: string,
): Promise<{ ok: true; value?: string } | { ok: false; error: string }> {
  if (!ref) return { ok: true };
  const name = normalizeSecretName(ref);
  const value = await secrets.get(principal, name, scope);
  if (value) return { ok: true, value };
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
