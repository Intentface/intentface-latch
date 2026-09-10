import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";
import { memorySweep } from "@/lib/memory/sweep";

/**
 * System cron entrypoint (prod replacement for the dev in-process tick).
 * Point Vercel Cron at `/api/cron` (see vercel.json). It does four things:
 *   • runDue()      — fire all tenants' due scheduled agents
 *   • sweep()       — reap lease-expired/crashed runs and resume them (durability)
 *   • memorySweep() — extract idle chats into episodic memory + consolidate
 *   • pruneExpired() — retention for the TTL'd channel tables and audit log
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
  const { runtime, slackStore, channelAudit } = await getLatch();
  const due = await runtime.runDue().catch((e: unknown) => ({ error: String(e) }));
  const swept = await runtime.sweep().catch((e: unknown) => ({ error: String(e) }));
  // Retention for the Slack channel's TTL'd tables (dedupe claims, held
  // replays, turn leases, and the legacy event table until it's dropped).
  await slackStore.pruneExpired().catch((e: unknown) => {
    console.error("[cron] slack prune failed:", e);
  });
  // Same for the channel audit log: its writes sweep opportunistically, but an
  // app that goes quiet must still shed its rows at the TTL.
  await channelAudit.pruneExpired().catch((e: unknown) => {
    console.error("[cron] channel audit prune failed:", e);
  });
  // Dev-only escape hatch: `?force=1` drops the idle gate so a fresh chat can
  // be extracted immediately (manual e2e testing). Never honored in prod.
  const force =
    process.env.NODE_ENV !== "production" &&
    new URL(request.url).searchParams.get("force") === "1";
  const memory = await memorySweep({ force }).catch((e: unknown) => ({ error: String(e) }));
  return Response.json({ ok: true, due, swept, memory });
}

export const Route = createFileRoute("/api/cron")({
  server: {
    handlers: {
      GET: ({ request }) => runCron(request),
      POST: ({ request }) => runCron(request),
    },
  },
});
