import { getRequest } from "@tanstack/react-start/server";
import { auth } from "./auth";

/**
 * Our Principal — opaque to Latch (it's generic over whatever we put here). Must
 * be JSON-serializable, since Latch persists it per run for resume. The `owner`
 * fn in `latch.ts` derives the isolation key from these fields.
 */
export interface Principal {
  orgId: string;
  /** Optional: omitted to address org-shared resources (e.g. an org-level credential). */
  userId?: string;
  /**
   * The human ACTING through this principal when it differs from `userId` —
   * set by channel turns (Slack) where the chat must stay owned by one stable
   * key (the binding's, so a shared thread never fragments per member) while
   * CREDENTIALS must resolve per typist (a member must never read through
   * another member's OAuth grants). Ignored by the `owner` derivation; consumed
   * by `credentialPrincipalOf`. Serialized with the run like every other field,
   * so resumes keep acting as the same human.
   */
  actorUserId?: string;
}

/**
 * The principal OAuth grants resolve under: the acting human when present,
 * else the principal itself. Every per-user credential read/write (MCP oauth
 * tokens, oauth2 grants) must go through this — resolving grants under the
 * raw channel principal is exactly the bug where everyone in a Slack channel
 * silently reads through the binding owner's integrations.
 */
export function credentialPrincipalOf(p: Principal): Principal {
  return p.actorUserId ? { orgId: p.orgId, userId: p.actorUserId } : p;
}

/**
 * The bridge: better-auth session → our `Principal`.
 * Active organization = tenant (`orgId`). A session WITHOUT an active org
 * yields null — same as unauthenticated. No fallback: defaulting a missing
 * org to a personal tenant once silently split one user's owner-keyed data
 * (OAuth tokens landed under `user:<id>` while the connection lived under
 * the real org). Every session is born pinned (`session.create.before` in
 * auth.ts + `ensurePersonalOrg` at signup), so null here means a stale
 * pre-hook session — re-login cures it. Fail loudly, never guess.
 */
export async function getPrincipalFromHeaders(
  headers: Headers,
): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.session.activeOrganizationId) return null;
  return {
    orgId: session.session.activeOrganizationId,
    userId: session.user.id,
  };
}

/** Ambient version — uses the real request Headers (works during SSR). */
export async function getPrincipal(): Promise<Principal | null> {
  return getPrincipalFromHeaders(getRequest().headers);
}

/**
 * Principal plus the session user's display identity (name/email). For flows
 * that bind an EXTERNAL identity to the logged-in account (channel link
 * confirmations), where the page must show WHO the browser is signed in as —
 * the whole point is catching a wrong-account session before it links.
 */
export async function getSessionUserFromHeaders(
  headers: Headers,
): Promise<{ principal: Principal; name?: string; email?: string } | null> {
  const session = await auth.api.getSession({ headers });
  // No active org → null, same as getPrincipalFromHeaders — never default.
  if (!session?.session.activeOrganizationId) return null;
  return {
    principal: {
      orgId: session.session.activeOrganizationId,
      userId: session.user.id,
    },
    name: session.user.name ?? undefined,
    email: session.user.email ?? undefined,
  };
}
