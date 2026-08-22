import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { getLatch } from "@/lib/latch";
import { getSlackChannelForApp } from "@/lib/slack-channel";
import { getPrincipalFromHeaders } from "@/lib/session";
import { isOrgMember } from "@/lib/auth";

/**
 * Landing after a Slack sign-in card's OAuth completes (the connections
 * callback redirects here). Approves the thread's parked `connect_<name>` and
 * resumes the turn INTO THE SLACK THREAD — without this the conversation
 * dead-ends: the tokens exist but the parked approval never resolves, and the
 * user is left staring at a browser tab while the thread stays silent.
 *
 * Auth mirrors the authorize leg (see resolveContext in latch.ts): a signed-in
 * member of the binding's org. The resume itself can't be abused into a
 * generic approval bypass — `resumeApproval` re-verifies against fresh history
 * that the id names a still-pending CONNECT approval, and approving a connect
 * only ever lets the synthetic connect tool return `{connected:true}`.
 */
async function handleConnectDone(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const appId = url.searchParams.get("app") ?? "";
  const chatId = url.searchParams.get("chatId") ?? "";
  const approvalId = url.searchParams.get("approvalId") ?? "";
  const slackUser = url.searchParams.get("user") ?? "";
  const error = url.searchParams.get("error");

  // Everything interpolated below is escaped — this branch renders BEFORE any
  // auth check, so an unescaped query param would be reflected XSS on the app
  // origin for any unauthenticated visitor.
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
        `<body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh">` +
        `<div style="text-align:center;max-width:28rem"><h1 style="font-size:1.2rem">${esc(title)}</h1>` +
        `<p style="color:#555">${esc(body)}</p></div>`,
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );

  // The callback appends ?error= on a failed exchange — surface it rather than
  // claiming success and resuming a turn whose connection is still dead.
  // Allowlisted to the codes the callback actually emits; anything else reads
  // as an unknown error rather than echoing attacker-chosen text.
  if (error) {
    const known = error === "missing_code" || error === "exchange_failed" ? error : "unknown error";
    return page("Connection failed", `The sign-in didn't complete (${known}). Close this tab and try the card in Slack again.`, 400);
  }
  if (!appId || !chatId || !approvalId) return page("Invalid link", "This link is missing its context.", 400);

  const session = await getPrincipalFromHeaders(request.headers);
  if (!session?.userId) return page("Not signed in", "Sign in to Latch, then use the card in Slack again.", 401);

  const { slackStore } = await getLatch();
  const app = await slackStore.resolve(appId);
  if (!app) return page("Unknown app", "This Slack app is no longer bound.", 404);
  if (!(await isOrgMember(session.userId, app.orgId))) {
    return page("No access", "Your Latch account isn't a member of this agent's organization.", 403);
  }

  const resolved = await getSlackChannelForApp(appId);
  if (!resolved) return page("Unknown app", "This Slack app is no longer bound.", 404);

  // Resume in the background — the browser gets its confirmation immediately,
  // the answer streams into the thread (same pattern as the webhook's defer).
  waitUntil(
    resolved.channel
      .resumeApproval({ chatId, approvalId, userId: slackUser })
      .catch((e) => console.error("[slack] connect-done resume failed:", e)),
  );

  return page("Connected", "You can close this tab — the conversation continues in Slack.");
}

export const Route = createFileRoute("/api/slack/connect-done")({
  server: {
    handlers: {
      GET: ({ request }) => handleConnectDone(request),
    },
  },
});
