/**
 * @intentface/latch-server
 *
 * The mountable Latch HTTP surface — one framework-agnostic Web handler that
 * exposes the whole runtime (chat, approvals, chat/run lists, history) and the
 * generic MCP connection OAuth. Mount `createLatchHandler({ runtime, connections,
 * resolveContext })` at a single route in any Web-standard host (TanStack Start,
 * Next, Bun, Deno, serverless). For Hono, see `@intentface/latch-server/hono`.
 *
 * The routes are a convenience over the real contract — the Runtime operations —
 * which you can still call directly from your own routes / non-HTTP triggers.
 */
export { createLatchHandler } from "./handler.js";
export type { LatchHandlerConfig, LatchHandler } from "./handler.js";
export { createCronerEvaluator } from "./cron.js";
