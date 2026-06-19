import { getRequestHeaders } from "@tanstack/react-start/server";
import type { Principal } from "@intentface/latch-core";
import { auth } from "./auth";

/**
 * The bridge: better-auth session → Latch `Principal`.
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

/** Ambient version (inside a server fn / route). */
export async function getPrincipal(): Promise<Principal | null> {
  return getPrincipalFromHeaders(getRequestHeaders() as unknown as Headers);
}
