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
 * `{ ...runtimeContext, principal, run, writer, runtime }` as its
 * `options.context` (the runtime itself included, so a harness tool can
 * schedule or spawn without a host-global), so a tool that needs a credential
 * resolves it itself, scoped by the principal
 * (e.g. `vault.resolver(ctx.principal, "crm_api_key")`) — the model never sees
 * the value.
 *
 * Derive runtime context from DURABLE identity (look things up by ids on the
 * principal), so a resumed run or a scheduled trigger — which has no request —
 * rebuilds the same context.
 */

import type { Runtime, TurnWriter } from "./runtime.js";

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

/**
 * What a tool receives as `options.context` during a run: whatever your
 * `defineContext` `build` returned, plus what Latch adds for every tool.
 *
 * ```ts
 * execute: async ({ orderId }, { context }) => {
 *   const { orders, principal } = context as ToolContext<Principal, Ctx>;
 *   return orders.refund(orderId, principal.userId);
 * },
 * ```
 */
// Latch sets these on every tool's context, after spreading what `build`
// returned, so a built field with one of these names is overwritten.
type LatchToolKeys = "principal" | "run" | "writer" | "runtime";

// `Omit` per union member: on a union as a whole it keeps only the shared
// keys, so a context typed as `{ kind: "a"; a } | { kind: "b"; b }` would lose
// `a` and `b`.
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ToolContext<P, RuntimeContext = unknown> = OmitEach<RuntimeContext, LatchToolKeys> & {
  /** Who the run is for: the principal your route passed, or the one restored for a resumed or scheduled run. */
  principal: P;
  /** The run this tool call belongs to. `agent` is the agent's name as the run resolved it. */
  run: { id: string; chatId: string; agent: string };
  /** Streams extra parts (for example `data-*` progress) into the answer while the tool runs. */
  writer: TurnWriter;
  /** The runtime itself, for tools that schedule, list chats or start runs. */
  runtime: Runtime<P>;
};

export function defineContext<P, RuntimeContext>(
  def: ContextDefinition<P, RuntimeContext>,
): ContextDefinition<P, RuntimeContext> {
  return def;
}
