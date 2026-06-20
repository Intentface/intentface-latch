import type { Vault } from "@intentface/latch-core";
import type { Principal } from "./session";

/**
 * Connection API-key storage with a declarable scope. The owner-keyed Vault does
 * the isolation: a `"user"` key is stored at the caller's principal (owner
 * `[org,user]`), an `"org"` key at a userId-stripped principal (owner `[org]`,
 * shared across the org). Same Vault, two scopes — no framework change.
 */
export type CredentialScope = "user" | "org";

const ownerOf = (p: Principal, scope: CredentialScope): Principal =>
  scope === "org" ? { orgId: p.orgId } : p;

const vaultKey = (name: string) => `conn:${name}:apikey`;

export function createCredentials(vault: Vault<Principal>) {
  return {
    get: (p: Principal, name: string, scope: CredentialScope) =>
      vault.get(ownerOf(p, scope), vaultKey(name)),
    set: (p: Principal, name: string, scope: CredentialScope, value: string) =>
      vault.set(ownerOf(p, scope), vaultKey(name), value),
    has: (p: Principal, name: string, scope: CredentialScope) =>
      vault.has(ownerOf(p, scope), vaultKey(name)),
  };
}

export type Credentials = ReturnType<typeof createCredentials>;
