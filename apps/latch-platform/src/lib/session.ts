import { getRequestHeaders } from "@tanstack/react-start/server";
import type { Principal } from "@intentface/latch-core";
import { auth } from "./auth";

/**
 * The bridge: better-auth session → Latch `Principal`.
 *
 * The active organization is the tenant (`orgId`); a signed-in user with no
 * active org falls back to a personal scope so they always have a tenant.
 * Returns null when not authenticated.
 */
export async function getPrincipal(): Promise<Principal | null> {
  const headers = getRequestHeaders() as unknown as Headers;
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const orgId = session.session.activeOrganizationId ?? `user:${session.user.id}`;
  return { orgId, userId: session.user.id };
}
