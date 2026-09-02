/**
 * Per-project context definition.
 *
 * The AI SDK only has raw per-call `runtimeContext` / `toolsContext`. `defineContext`
 * is thin sugar (OURS, not an SDK API): a project declares its `RuntimeContext`
 * shape once and builds it per request from the (opaque, customer-typed)
 * `Principal`. The type then flows through `defineAgent`, prepareStep, hooks,
 * and tools.
 *
 * Tools receive the built context automatically: the runtime hands every tool
 * `{ ...runtimeContext, principal, run, writer }` as its `options.context`, so a
 * tool that needs a credential resolves it itself, scoped by the principal
 * (e.g. `vault.resolver(ctx.principal, "crm_api_key")`) — the model never sees
 * the value.
 *
 * Derive runtime context from DURABLE identity (look things up by ids on the
 * principal), so a resumed run or a scheduled trigger — which has no request —
 * rebuilds the same context.
 */

/** Reads a secret for a principal (the Vault read-side; isolation lives in the store). */
export type SecretResolver<P> = (
  principal: P,
  key: string,
) => Promise<string | undefined>;

export interface ContextDefinition<P, RuntimeContext> {
  /**
   * Build the shared runtime context for a request from its principal.
   *
   * `turnContext` is the per-turn request payload (e.g. the parsed POST body or
   * a caller-supplied object) — EPHEMERAL by design. Unlike the principal it is
   * never persisted with a run, so a resumed/cron-fired turn rebuilds context
   * without it: derive anything durable from the principal, and treat
   * `turnContext` as optional per-turn enrichment only.
   */
  build: (args: {
    principal: P;
    request?: Request;
    turnContext?: unknown;
  }) => RuntimeContext | Promise<RuntimeContext>;
}

export function defineContext<P, RuntimeContext>(
  def: ContextDefinition<P, RuntimeContext>,
): ContextDefinition<P, RuntimeContext> {
  return def;
}
