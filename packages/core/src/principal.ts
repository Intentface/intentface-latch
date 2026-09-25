/**
 * Identity & tenancy primitives.
 *
 * Latch carries NO tenancy vocabulary of its own. The customer defines their
 * own `Principal` type (`P`) — whatever their auth produces (tenant/team/user,
 * a workspace id, a single user id, anything). It must be JSON-serializable, so
 * the runtime can persist it per run and rebuild it for resume/cron.
 *
 * The framework treats `P` as opaque: it threads it to the storage adapter,
 * secret store, context builder, tools, and agents — but never reads a field of
 * it. Isolation is enforced in the adapter/store (via an `owner` key derived
 * from the principal), and authorization lives in the customer's app. There is
 * no `Scope`, no `orgId`/`userId` — those, if they exist, live in the
 * customer's `P` and the `owner` function they give their adapter.
 *
 * CONTRACT — principals persist in CLEARTEXT. The runtime serializes `P`
 * verbatim onto durable rows (`runs.identity`, `schedules.identity`, memory
 * episodes) and into OAuth flow state, and replays it on resume/cron — days
 * or months later. Therefore a principal must carry DURABLE IDENTIFIERS ONLY:
 *   - never secrets or tokens (they'd be stored unencrypted and replayed
 *     stale — credentials belong in the Vault);
 *   - no PII beyond ids (emails, names — they'd spread across tables and
 *     complicate erasure);
 *   - nothing volatile (roles, flags, session state — a replayed copy would
 *     silently disagree with reality; derive those per turn in
 *     `context.build`, and re-validate stale identity in
 *     `reconstructPrincipal`).
 */

/** Maps an incoming web request to a `Principal`. Customer-provided. Null = unauthenticated. */
export type ContextResolver<P> = (
  request: Request,
) => P | null | Promise<P | null>;

/**
 * Rebuilds a `Principal` from the opaque identity blob persisted on a run, for
 * non-interactive triggers (resume, cron) where there is no request. The mirror
 * of `ContextResolver`. Default in the runtime is a passthrough.
 *
 * Return `null` to REFUSE the identity — e.g. the user was removed from the
 * tenant, or their account is gone since the run/schedule was created. That
 * is a permanent answer, and the runtime makes it terminal: a refused cron
 * fire disables its schedule, a refused resume ends its run `errored`. Throw
 * only for a transient failure (the lookup itself broke): a throw is an error
 * for that occurrence — which is still consumed, so a recurring schedule stays
 * live for its next one and a one-shot is spent — and a thrown resume is
 * retried once its lease lapses.
 *
 * Only `null` refuses. `undefined` is not a refusal: the default passthrough
 * yields it for identity-less rows, which must keep running.
 */
export type ReconstructPrincipal<P> = (
  identity: unknown,
) => P | null | Promise<P | null>;
