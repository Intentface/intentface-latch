import { Hono } from "hono";
import { createLatchHandler } from "./handler.js";
import type { LatchHandlerConfig } from "./handler.js";

/**
 * A mountable Hono app over the framework-agnostic `createLatchHandler`. Mount
 * it under any prefix with your own middleware, or run it standalone. Identical
 * routes/behavior to the bare handler — this is just the Hono adapter, kept in a
 * subpath export (`@intentface/latch-server/hono`) so `hono` stays an optional
 * peer dependency for hosts that don't use it (TanStack Start, Next, etc.).
 */
export type LatchServerConfig<P> = LatchHandlerConfig<P>;

export function createLatchHono<P>(config: LatchServerConfig<P>): Hono {
  const handler = createLatchHandler(config);
  const app = new Hono();
  app.all("*", async (c) => (await handler(c.req.raw)) ?? c.notFound());
  return app;
}
