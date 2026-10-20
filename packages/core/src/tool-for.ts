import { tool, type Tool, type ToolExecuteFunction } from "ai";
import type { ToolContext } from "./context.js";

/**
 * Types only: the AI SDK's `tool()`, with `options.context` typed for your app.
 * Nothing changes at runtime (it calls `tool()` and returns its tool), and a
 * plain `tool()` with a cast works exactly the same.
 *
 * The context is what your
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
 * Why it exists: the AI SDK's own way to type a tool's context is a `contextSchema`, which
 * validates at runtime; Latch's context holds clients and functions, so this
 * types it without one. Add `Params` and `MessageContext` for an agent that
 * declares `params` or reads the `data-context` part. A tool without
 * `execute` (one the client or a queue answers) is fine too.
 */
export function toolFor<P, RuntimeContext = unknown, Params = unknown, MessageContext = unknown>(): ToolFactory<
  LatchToolContext<P, RuntimeContext, Params, MessageContext>
> {
  return ((definition: Tool<unknown, unknown, never>) => tool(definition)) as never;
}

/** What `toolFor` returns: `tool()`'s two shapes, with `CONTEXT` as the tool's context. */
export interface ToolFactory<CONTEXT extends Record<string, unknown>> {
  /** A tool that runs here: `execute` receives `CONTEXT` as `options.context`. */
  <INPUT, OUTPUT>(
    definition: Tool<INPUT, OUTPUT, CONTEXT> & { execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT> },
  ): Tool<INPUT, OUTPUT, CONTEXT>;
  /** A tool without `execute`, answered by the client or a queue. */
  <INPUT>(definition: Tool<INPUT, never, CONTEXT>): Tool<INPUT, never, CONTEXT>;
}

/** `ToolContext`, in the shape the AI SDK's `Tool` takes as its context. */
export type LatchToolContext<P, RuntimeContext = unknown, Params = unknown, MessageContext = unknown> = ToolContext<
  P,
  RuntimeContext,
  Params,
  MessageContext
> &
  Record<string, unknown>;
