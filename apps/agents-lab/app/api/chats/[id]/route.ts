import { renderTranscript } from "@intentface/agents-sdk";
import { db, extensionsFor, loadMessages, owner } from "@/lib/agent";
import { currentPrincipal } from "@/lib/principal";

/**
 * The load route. `renderTranscript` applies the same view rules the live
 * stream used, so what a reader sees after a reload cannot drift from what
 * they saw while it streamed. The read is owner-fenced, so a leaked chat id
 * returns an empty transcript rather than someone else's conversation.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const principal = await currentPrincipal();
  if (!principal) return new Response("Sign in first.", { status: 401 });
  const { id } = await ctx.params;
  return Response.json({
    messages: renderTranscript(
      extensionsFor(id, principal),
      loadMessages(db(), id, owner(principal)),
      { runId: "render", principal },
    ),
  });
}
