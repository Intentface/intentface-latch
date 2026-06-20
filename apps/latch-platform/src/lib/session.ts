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
}

/**
 * The bridge: better-auth session → our `Principal`.
 * Active organization = tenant (`orgId`); signed-in users with no active org
 * fall back to a personal scope. Returns null when not authenticated.
 */
export async function getPrincipalFromHeaders(
  headers: Headers,
): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const orgId = session.session.activeOrganizationId ?? `user:${session.user.id}`;
  return { orgId, userId: session.user.id };
}

/** Ambient version — uses the real request Headers (works during SSR). */
export async function getPrincipal(): Promise<Principal | null> {
  return getPrincipalFromHeaders(getRequest().headers);
}
