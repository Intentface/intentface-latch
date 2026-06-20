/**
 * Per-project context definition.
 *
 * The AI SDK only has raw per-call `runtimeContext` / `toolsContext`. `defineContext`
 * is thin sugar (OURS, not an SDK API): a project declares its `RuntimeContext`
 * shape once, builds it per request from the (opaque, customer-typed) `Principal`,
 * and resolves per-tool secrets. The type then flows through `defineAgent`,
 * prepareStep, hooks, tools.
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
  /** Build the shared runtime context for a request from its principal. */
  build: (args: {
    principal: P;
    request?: Request;
  }) => RuntimeContext | Promise<RuntimeContext>;
  /** Optional: map runtime context → per-tool context (secrets resolved here). */
  toolsContext?: (
    runtime: RuntimeContext,
    secrets: SecretResolver<P>,
  ) =>
    | Record<string, Record<string, unknown>>
    | Promise<Record<string, Record<string, unknown>>>;
}

export function defineContext<P, RuntimeContext>(
  def: ContextDefinition<P, RuntimeContext>,
): ContextDefinition<P, RuntimeContext> {
  return def;
}
