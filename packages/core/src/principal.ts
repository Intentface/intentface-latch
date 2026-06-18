/**
 * Identity & tenancy primitives.
 *
 * Latch never authenticates. The customer's `ContextResolver` turns an incoming
 * request into a `Principal` (who is calling, in which org). Every storage
 * operation is then scoped by that principal — so cross-tenant access is
 * impossible by construction, not by a check someone has to remember.
 */

/** The resolved identity for a request. */
export interface Principal {
  /** Tenant the caller belongs to. Required — everything is org-scoped. */
  orgId: string;
  /** The acting user, when there is one (absent for service/background runs). */
  userId?: string;
  /** Optional plan/tier, for gating and behaviour. */
  plan?: string;
  /** Optional capability scopes/roles for fine-grained authorization. */
  scopes?: string[];
  /** Anything else the customer wants to carry through. */
  meta?: Record<string, unknown>;
}

/** Maps an incoming web request to a `Principal`. Customer-provided. */
export type ContextResolver = (request: Request) => Principal | Promise<Principal>;

/** The tenant scope used to filter every storage query (default-safe isolation). */
export interface Scope {
  orgId: string;
  userId?: string;
}

/** Narrow a `Principal` to the storage `Scope`. */
export function scopeOf(principal: Principal): Scope {
  return { orgId: principal.orgId, userId: principal.userId };
}
