import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { slackChannel } from "@intentface/latch-channels/slack";
import { getLatch } from "@/lib/latch";
import { slackVaultKeys } from "@/lib/slack-store";
import { buildLinkUrl } from "@/lib/slack-link";
import type { Principal } from "@/lib/session";

/**
 * The ONE Slack webhook (events + interactivity) for every agent's dedicated
 * app. Slack apps are created with this shared request URL; we resolve WHICH
 * agent a request is for by its `api_app_id`, then verify with that app's own
 * signing secret and run the turn as the agent's owner. (Not auto-mounted —
 * Latch is a library; this is the single explicit mount, like the Latch handler.)
 */

/** The app's canonical base URL (for building connection authorize links). */
function baseUrl(): string {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : "http://localhost:3000";
}

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

  const { runtime, slackStore, credentials } = await getLatch();
  const app = await slackStore.resolve(appId);
  if (!app) return new Response("app not registered", { status: 404 });

  // Run as the agent's owner (the Principal that published the Slack app).
  const principal: Principal = { orgId: app.orgId, userId: app.userId };
  const keys = slackVaultKeys(appId);

  const channel = slackChannel<Principal>({
    agent: app.agent,
    principal,
    botName: app.botName,
    botToken: async () => (await credentials.get(principal, keys.botToken, "org")) ?? "",
    signingSecret: async () => (await credentials.get(principal, keys.signingSecret, "org")) ?? "",
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    // Only platform users who've linked their Slack identity may drive the
    // agent (it runs with the owner's credentials, so randos can't use it).
    authorizeUser: async ({ teamId, userId }) => {
      const team = teamId || app.teamId || "";
      const linked = await slackStore.resolveIdentity(team, userId);
      if (linked) return { allowed: true };
      return {
        allowed: false,
        message: "You need a Latch account to use this agent.",
        linkUrl: buildLinkUrl(baseUrl(), team, userId),
      };
    },
    // Keep the serverless function alive for the background turn after we ACK.
    waitUntil: (p) => waitUntil(p),
    // Cross-invocation dedupe of Slack's retries.
    seen: (eventId) => slackStore.seen(eventId),
    // `connect_<name>` OAuth approvals → the platform authorize URL, resumed in-chat.
    authorizeUrl: (name, ctx) => {
      const q = new URLSearchParams({
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        returnTo: `${baseUrl()}/chat/${ctx.chatId}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return channel.handleRequest(request);
}

export const Route = createFileRoute("/api/slack")({
  server: {
    handlers: {
      POST: ({ request }) => handleSlack(request),
    },
  },
});
