import { describe, expect, it, vi } from "vitest";
import { createLatchHandler } from "./handler.js";

/**
 * `cron/run` is the one route without a user: it runs every customer's due
 * schedules. It exists only with a `cronSecret`, and takes the secret the way
 * Vercel Cron sends it (a GET with a bearer token) as well as our own header.
 */

function build(cronSecret?: string) {
  const cronRun = vi.fn(async () => ({ due: { fired: 0 }, resumed: [] }));
  const resolvePrincipal = vi.fn(() => null);
  const handler = createLatchHandler({ runtime: {} as never, resolvePrincipal, cronSecret, cronRun });
  return { handler, cronRun, resolvePrincipal };
}

const cron = (init: RequestInit = {}) => new Request("https://app.example/cron/run", init);

describe("cron/run", () => {
  it("doesn't exist without a secret", async () => {
    const { handler, cronRun } = build();
    const res = await handler(cron({ headers: { authorization: "Bearer undefined" } }));
    expect(res?.status).toBe(404);
    expect(cronRun).not.toHaveBeenCalled();
  });

  it("runs for Vercel Cron: GET with a bearer token", async () => {
    const { handler, cronRun, resolvePrincipal } = build("s3cret");
    const res = await handler(cron({ headers: { authorization: "Bearer s3cret" } }));
    expect(res?.status).toBe(200);
    expect(cronRun).toHaveBeenCalledOnce();
    // No user is involved.
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it("runs for a POST with the x-latch-cron-secret header", async () => {
    const { handler, cronRun } = build("s3cret");
    const res = await handler(cron({ method: "POST", headers: { "x-latch-cron-secret": "s3cret" } }));
    expect(res?.status).toBe(200);
    expect(cronRun).toHaveBeenCalledOnce();
  });

  it("refuses a wrong, partial or missing secret", async () => {
    const { handler, cronRun } = build("s3cret");
    const attempts: Record<string, string>[] = [
      { authorization: "Bearer nope" },
      { authorization: "Bearer s3cre" },
      { authorization: "s3cret" },
      {},
    ];
    for (const headers of attempts) {
      expect((await handler(cron({ headers })))?.status).toBe(403);
    }
    expect(cronRun).not.toHaveBeenCalled();
  });
});
