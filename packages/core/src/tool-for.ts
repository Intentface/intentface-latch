import { tool, type Tool, type ToolExecuteFunction } from "ai";
import type { ToolContext } from "./context.js";

/**
 * The AI SDK's `tool()`, with `options.context` typed for your app: what your
 * context function returns, plus what Latch adds (`principal`, `run`,
 * `writer`, `runtime`, `params`, `messageContext`). Make it once, use it for
 * every tool, and drop the `context as ToolContext<…>` cast:
 *
 * ```ts
 * export const tool = toolFor<Principal, Ctx>();
 *
 * const find_ticket = tool({
 *   description: "Look up a ticket",
 *   inputSchema: z.object({ id: z.string() }),
 *   execute: async ({ id }, { context }) => context.db.tickets.get(id),
 * });
 * ```
 *
 * The types are the only difference: it calls `tool()` and returns its tool. The
 * AI SDK's own way to type a tool's context is a `contextSchema`, which
 * validates at runtime; Latch's context holds clients and functions, so this
 * types it without one. Add `Params` and `MessageContext` for an agent that
 * declares `params` or reads the `data-context` part.
 */
export function toolFor<P, RuntimeContext = unknown, Params = unknown, MessageContext = unknown>(): <INPUT, OUTPUT>(
  definition: TypedTool<INPUT, OUTPUT, LatchToolContext<P, RuntimeContext, Params, MessageContext>>,
) => Tool<INPUT, OUTPUT, LatchToolContext<P, RuntimeContext, Params, MessageContext>> {
  return (definition) => tool(definition);
}

/** `ToolContext`, in the shape the AI SDK's `Tool` takes as its context. */
export type LatchToolContext<P, RuntimeContext = unknown, Params = unknown, MessageContext = unknown> = ToolContext<
  P,
  RuntimeContext,
  Params,
  MessageContext
> &
  Record<string, unknown>;

/** A tool definition whose `execute` receives `CONTEXT` as `options.context`. */
export type TypedTool<INPUT, OUTPUT, CONTEXT extends Record<string, unknown>> = Tool<INPUT, OUTPUT, CONTEXT> & {
  execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
};
