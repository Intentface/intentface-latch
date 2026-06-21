import type { Vault } from "@intentface/latch-core";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";

/**
 * UI-added connections, stored as encrypted Vault entries (no separate table).
 * Each is one blob at the chosen scope's owner: `"org"` → `{ orgId }` (shared
 * across the org), `"user"` → the caller (`{ orgId, userId }`). The auth token
 * lives inside the encrypted blob — brokered server-side, never sent to the
 * model. Agents bind to these by name (`connections: [...]`).
 */
export interface StoredConnection {
  kind: "mcp" | "openapi";
  name: string;
  /** MCP: the server URL. */
  mcp?: { url: string };
  /** OpenAPI: spec URL (or inline), base URL, optional operation allow-list. */
  openapi?: { spec: string; baseUrl?: string; operations?: string[] };
  /** Token/key auth. `bearer` → Authorization: Bearer; `header` → a named header. */
  auth?: { kind: "bearer" | "header"; header?: string; token: string };
}

/** A stored connection plus the scope it lives at (for listing/UI). */
export interface ScopedConnection extends StoredConnection {
  scope: CredentialScope;
}

const PREFIX = "connection:";
const vaultKey = (name: string) => `${PREFIX}${name}`;
const orgPrincipal = (p: Principal): Principal => ({ orgId: p.orgId });

export function createConnectionStore(vault: Vault<Principal>) {
  async function listAt(p: Principal, scope: CredentialScope): Promise<ScopedConnection[]> {
    const owner = scope === "org" ? orgPrincipal(p) : p;
    const keys = (await vault.list(owner)).filter((k) => k.startsWith(PREFIX));
    const out: ScopedConnection[] = [];
    for (const k of keys) {
      const raw = await vault.get(owner, k);
      if (raw) out.push({ ...(JSON.parse(raw) as StoredConnection), scope });
    }
    return out;
  }

  return {
    /** All connections visible to the caller: org-shared + their personal ones. */
    async list(p: Principal): Promise<ScopedConnection[]> {
      const [org, user] = await Promise.all([listAt(p, "org"), listAt(p, "user")]);
      return [...org, ...user];
    },

    /** One connection by name — personal wins over org on a name clash. */
    async get(p: Principal, name: string): Promise<ScopedConnection | undefined> {
      const personal = await vault.get(p, vaultKey(name));
      if (personal) return { ...(JSON.parse(personal) as StoredConnection), scope: "user" };
      const org = await vault.get(orgPrincipal(p), vaultKey(name));
      if (org) return { ...(JSON.parse(org) as StoredConnection), scope: "org" };
      return undefined;
    },

    async add(p: Principal, scope: CredentialScope, conn: StoredConnection): Promise<void> {
      const owner = scope === "org" ? orgPrincipal(p) : p;
      await vault.set(owner, vaultKey(conn.name), JSON.stringify(conn));
    },

    async remove(p: Principal, scope: CredentialScope, name: string): Promise<void> {
      const owner = scope === "org" ? orgPrincipal(p) : p;
      await vault.delete(owner, vaultKey(name));
    },
  };
}

export type ConnectionStore = ReturnType<typeof createConnectionStore>;
