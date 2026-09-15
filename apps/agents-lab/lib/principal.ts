/**
 * Session → Principal.
 *
 * The shape is declared ONCE here by augmenting the SDK's `Principal`, which
 * is why nothing downstream carries a generic. Everything below reads this
 * type; nothing in the SDK reads a field of it.
 *
 * Durable identifiers only. A principal is persisted in cleartext with a chat
 * and replayed on a scheduled run months later, so roles, plan flags and
 * display names must be looked up per turn rather than carried here.
 */
import { headers } from "next/headers";
import { auth, firstOrgFor } from "./auth";

declare module "@intentface/agents-sdk" {
  interface Principal {
    orgId: string;
    userId: string;
  }
}

export interface LabPrincipal {
  orgId: string;
  userId: string;
}

/** The isolation key. Conversations and budgets belong to an ORG, not a person. */
export const owner = (p: LabPrincipal) => p.orgId;

export async function currentPrincipal(): Promise<LabPrincipal | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  // Resolve in order: the session's pinned org, then actual membership, then
  // the personal id as a last resort. Reaching straight for `user:<id>` when
  // the session is unpinned is the bug that splits a tenant in half — a member
  // of a real org would land in their personal tenant instead, and their
  // conversations and budgets would quietly accumulate under two owners.
  const pinned = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  const orgId = pinned ?? firstOrgFor(session.user.id) ?? `user:${session.user.id}`;
  return { orgId, userId: session.user.id };
}

export async function requirePrincipal(): Promise<LabPrincipal> {
  const p = await currentPrincipal();
  if (!p) throw new UnauthenticatedError();
  return p;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "UnauthenticatedError";
  }
}
