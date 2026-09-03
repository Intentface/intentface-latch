import { verifySlackSignature } from "@intentface/latch-channels/slack";
import type { StateStore } from "./state.js";

/**
 * The one Slack event this app receives: `app_mention`. It does not start a
 * turn of its own — it queues the mention and makes the channel's schedule due,
 * so a tag flows through the same read → think → update → speak loop as
 * everything else, just now instead of at the next cadence.
 */
export function createEventsHandler(deps: {
  signingSecret: string;
  isWatched: (channel: string) => boolean;
  state: StateStore;
  /** Make the channel's tick run now (fire-and-forget; must not throw). */
  wake: (channel: string) => void;
  botUserId?: () => Promise<string>;
  now?: () => number;
}): (req: Request) => Promise<Response> {
  return async (req) => {
    const rawBody = await req.text();
    const ok = verifySlackSignature({
      signingSecret: deps.signingSecret,
      rawBody,
      signature: req.headers.get("x-slack-signature"),
      timestamp: req.headers.get("x-slack-request-timestamp"),
      now: deps.now?.(),
    });
    if (!ok) return new Response("bad signature", { status: 401 });

    let body: { type?: string; challenge?: string; event?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
    if (body.type !== "event_callback" || body.event?.type !== "app_mention") return new Response("ignored");

    const e = body.event as { channel?: string; ts?: string; thread_ts?: string; user?: string; text?: string; bot_id?: string };
    if (!e.channel || !e.ts || !deps.isWatched(e.channel) || e.bot_id) return new Response("ignored");
    if (deps.botUserId && e.user && e.user === (await deps.botUserId())) return new Response("ignored");

    await deps.state.addMention(e.channel, {
      ts: e.ts,
      ...(e.thread_ts && e.thread_ts !== e.ts ? { threadTs: e.thread_ts } : {}),
      ...(e.user ? { userId: e.user } : {}),
      text: e.text ?? "",
    });
    deps.wake(e.channel);
    return new Response("ok");
  };
}
