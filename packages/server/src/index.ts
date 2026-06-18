/**
 * @intentface/latch-server
 *
 * Hono routes for Latch. Mount `createLatchHono({ runtime, resolveContext })`
 * into your existing app, or run it standalone. The routes are a convenience —
 * the real contract is the Runtime operations, which you can also call from your
 * own routes / non-HTTP triggers.
 */
export { createLatchHono } from "./server.js";
export type { LatchServerConfig } from "./server.js";
