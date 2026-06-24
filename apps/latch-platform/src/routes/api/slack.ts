import { createFileRoute } from "@tanstack/react-router";
import { getSlackChannelForApp } from "@/lib/slack-channel";

/**
 * The ONE Slack webhook (events + interactivity) for every agent's dedicated
 * app. Slack apps are created with this shared request URL; we resolve WHICH
 * agent a request is for by its `api_app_id`, then the channel verifies with
 * that app's own signing secret and runs the turn as the agent's owner.
 */

/** Peek the Slack `api_app_id` without consuming the request body. */
async function peekAppId(request: Request): Promise<{ appId: string | null; challenge?: string }> {
  const raw = await request.clone().text();
  const ct = request.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(raw).get("payload");
      if (!payload) return { appId: null };
      const p = JSON.parse(payload) as { api_app_id?: string };
      return { appId: p.api_app_id ?? null };
    }
    const body = JSON.parse(raw || "{}") as {
      type?: string;
      challenge?: string;
      api_app_id?: string;
    };
    // URL-verification handshake has no app id and needs no signature check.
    if (body.type === "url_verification") return { appId: null, challenge: body.challenge ?? "" };
    return { appId: body.api_app_id ?? null };
  } catch {
    return { appId: null };
  }
}

async function handleSlack(request: Request): Promise<Response> {
  const { appId, challenge } = await peekAppId(request);
  if (challenge !== undefined) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  if (!appId) return new Response("unknown app", { status: 400 });

  const resolved = await getSlackChannelForApp(appId);
  if (!resolved) return new Response("app not registered", { status: 404 });
  return resolved.channel.handleRequest(request);
}

export const Route = createFileRoute("/api/slack")({
  server: {
    handlers: {
      POST: ({ request }) => handleSlack(request),
    },
  },
});
