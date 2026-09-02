import { Hono } from "hono";
import { createLatchHandler } from "./handler.js";
import type { LatchHandlerConfig } from "./handler.js";
import { createLatchApp } from "./app.js";
import type { LatchApp, LatchAppConfig } from "./app.js";

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
  return honoOver(handler);
}

function honoOver(handler: (req: Request) => Promise<Response | undefined>): Hono {
  const app = new Hono();
  app.all("*", async (c) => (await handler(c.req.raw)) ?? c.notFound());
  return app;
}

/**
 * `createLatchApp` + a mounted Hono app in one call: the whole backend, ready
 * to `serve({ fetch: app.fetch })` or `app.route("/api/latch", …)` into yours.
 */
export async function createLatchHonoApp<P, RC = unknown>(
  config: LatchAppConfig<P, RC>,
): Promise<LatchApp<P> & { app: Hono }> {
  const latch = await createLatchApp<P, RC>(config);
  return { ...latch, app: honoOver(latch.handler) };
}
