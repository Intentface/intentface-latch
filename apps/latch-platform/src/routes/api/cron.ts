import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";
import { memorySweep } from "@/lib/memory/sweep";

/**
 * System cron entrypoint (prod replacement for the dev in-process tick).
 * Point Vercel Cron at `/api/cron` (see vercel.json). It does two things:
 *   • runtime.cron() — fire all tenants' due scheduled agents, then reap
 *                      lease-expired/crashed runs and resume them (durability)
 *   • memorySweep()  — extract idle chats into episodic memory + consolidate
 *
 * Guarded by Vercel's `CRON_SECRET` (Vercel sends it as `Authorization:
 * Bearer …`). Unauthenticated and system-wide, so it fails CLOSED: in production
 * an unset secret refuses every request rather than leaving all tenants'
 * schedules runnable by anyone. Only dev runs it unguarded.
 */
async function runCron(request: Request): Promise<Response> {
  const forbidden = () => new Response("Forbidden", { status: 403 });
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[cron] CRON_SECRET is not set — refusing to run");
      return forbidden();
    }
  } else {
    const expected = Buffer.from(`Bearer ${secret}`);
    const got = Buffer.from(request.headers.get("authorization") ?? "");
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return forbidden();
  }
  const { runtime, channelStore } = await getLatch();
  // Phases are isolated inside cron(): a runDue failure is reported in
  // `errors` and the sweep still runs (and vice versa).
  const latch = await runtime.cron().catch((e: unknown) => ({ error: String(e) }));
  if ("errors" in latch && latch.errors.length) console.error("[cron] latch phase failed:", latch.errors);
  // Retention for the channels' TTL'd tables (dedupe claims, held replays, turn leases).
  await channelStore.pruneExpired().catch((e: unknown) => {
    console.error("[cron] channel prune failed:", e);
  });
  // Dev-only escape hatch: `?force=1` drops the idle gate so a fresh chat can
  // be extracted immediately (manual e2e testing). Never honored in prod.
  const force =
    process.env.NODE_ENV !== "production" &&
    new URL(request.url).searchParams.get("force") === "1";
  const memory = await memorySweep({ force }).catch((e: unknown) => ({ error: String(e) }));
  return Response.json({ ok: true, latch, memory });
}

export const Route = createFileRoute("/api/cron")({
  server: {
    handlers: {
      GET: ({ request }) => runCron(request),
      POST: ({ request }) => runCron(request),
    },
  },
});
