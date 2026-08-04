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
  /**
   * Auth strategy. `bearer`/`header` carry a static token (brokered server-side).
   * `oauth` (MCP only) holds no secret — the per-user tokens come from the
   * interactive OAuth flow and live under the caller's own Vault scope.
   * `oauth2` (OpenAPI only) is a classic pre-registered authorization-code
   * client: explicit endpoints + client credentials, while the GRANTS are always
   * per-user — each caller authorizes with their own account and their tokens
   * live under their own Vault scope, even for org-shared connections.
   *
   * SECRETS ARE REFERENCES. `tokenRef` / `clientSecretRef` name a
   * {@link NamedSecretRef} in the same scope as this connection, resolved at
   * EGRESS (see `dynamic-connections.ts`) rather than copied in here. That is
   * what makes the Secrets page's Replace rotate every dependent connection at
   * once and its Delete actually revoke.
   *
   * The inline `token` / `clientSecret` are the pre-reference shape, kept
   * readable forever: connections written before this existed still work, and
   * they migrate to a ref the next time their secret is retyped. Exactly one of
   * the pair is set on any given record — the ref wins if both somehow are.
   */
  auth?:
    | { kind: "bearer" | "header"; header?: string; token?: string; tokenRef?: string }
    | { kind: "oauth"; scopes?: string[] }
    | {
        kind: "oauth2";
        authorizeUrl: string;
        tokenUrl: string;
        clientId: string;
        clientSecret?: string;
        clientSecretRef?: string;
        scopes?: string[];
      };
}

/**
 * The named secret a connection depends on, if any — the back-link that
 * inlining never had. Drives "Used by …" on the Secrets page and the
 * dependency list on delete.
 */
export function connectionSecretRef(conn: StoredConnection): string | undefined {
  const auth = conn.auth;
  if (!auth) return undefined;
  if (auth.kind === "bearer" || auth.kind === "header") return auth.tokenRef;
  if (auth.kind === "oauth2") return auth.clientSecretRef;
  return undefined;
}

/** Key for {@link secretDependents} — scope is part of a secret's identity. */
export const secretKey = (scope: CredentialScope, name: string) => `${scope}:${name}`;

/**
 * Connection names grouped by the secret they depend on. Scope-exact: a
 * user-level secret and an org-level one sharing a name are different
 * credentials, and a connection only ever resolves against its own scope.
 */
export function secretDependents(conns: ScopedConnection[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of conns) {
    const ref = connectionSecretRef(c);
    if (!ref) continue;
    const key = secretKey(c.scope, ref);
    out.set(key, [...(out.get(key) ?? []), c.name]);
  }
  return out;
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
