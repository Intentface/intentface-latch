import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";

/**
 * System cron entrypoint (prod replacement for the dev in-process tick).
 * Point Vercel Cron at `/api/cron` (see vercel.json). It does two things:
 *   • runDue()  — fire all tenants' due scheduled agents
 *   • sweep()   — reap lease-expired/crashed runs and resume them (durability)
 *
 * Guarded by Vercel's `CRON_SECRET` (Vercel sends it as `Authorization:
 * Bearer …`). With no secret set the route runs unguarded (dev only).
 */
async function runCron(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Forbidden", { status: 403 });
  }
  const { runtime } = await getLatch();
  const due = await runtime.runDue().catch((e: unknown) => ({ error: String(e) }));
  const swept = await runtime.sweep().catch((e: unknown) => ({ error: String(e) }));
  return Response.json({ ok: true, due, swept });
}

export const Route = createFileRoute("/api/cron")({
  server: {
    handlers: {
      GET: ({ request }) => runCron(request),
      POST: ({ request }) => runCron(request),
    },
  },
});
