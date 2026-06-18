import type { Principal, Scope } from "./principal.js";

/**
 * Per-project context definition.
 *
 * The AI SDK only has raw per-call `runtimeContext` / `toolsContext`. `defineContext`
 * is thin sugar (OURS, not an SDK API): a project declares its `RuntimeContext`
 * shape once, builds it per request from the `Principal`, and resolves per-tool
 * secrets. The type then flows through `defineAgent`, prepareStep, hooks, tools.
 */

/** Reads a tenant-scoped secret (the Vault read-side). */
export type SecretResolver = (
  scope: Scope,
  key: string,
) => Promise<string | undefined>;

export interface ContextDefinition<RuntimeContext> {
  /** Build the shared runtime context for a request from its principal. */
  build: (args: {
    principal: Principal;
    request?: Request;
  }) => RuntimeContext | Promise<RuntimeContext>;
  /** Optional: map runtime context → per-tool context (secrets resolved here). */
  toolsContext?: (
    runtime: RuntimeContext,
    secrets: SecretResolver,
  ) =>
    | Record<string, Record<string, unknown>>
    | Promise<Record<string, Record<string, unknown>>>;
}

export function defineContext<RuntimeContext>(
  def: ContextDefinition<RuntimeContext>,
): ContextDefinition<RuntimeContext> {
  return def;
}
