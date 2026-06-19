import { createFileRoute } from "@tanstack/react-router";
import type { AppMessage } from "@intentface/latch-core";
import { getPrincipalFromHeaders } from "@/lib/session";
import { getLatch } from "@/lib/latch";

/**
 * Chat endpoint for `useChat`. Resolves the Principal from the session, then
 * runs the durable `assistant` agent scoped to the org. The DB is the source of
 * truth, so we take the latest client message as the new turn and let the
 * runtime load prior history itself. The chat id is namespaced by org.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const principal = await getPrincipalFromHeaders(request.headers);
        if (!principal) return new Response("Unauthorized", { status: 401 });

        const body = (await request.json()) as {
          messages?: AppMessage[];
          id?: string;
        };
        const messages = body.messages ?? [];
        const message = messages[messages.length - 1];
        if (!message) return new Response("No message", { status: 400 });

        const { runtime } = await getLatch();
        // chatId is a client-generated uuid; tenant isolation is enforced by
        // the storage scope (orgId on the row + scoped reads), so no prefixing.
        return runtime.handleChat({
          agent: "assistant",
          chatId: body.id ?? crypto.randomUUID(),
          principal,
          message,
        });
      },
    },
  },
});
