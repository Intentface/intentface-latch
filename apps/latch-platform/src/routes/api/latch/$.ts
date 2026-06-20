import { createFileRoute } from "@tanstack/react-router";
import { getLatch } from "@/lib/latch";

/**
 * The ONE Latch route. Every Latch operation — chat streaming, approvals, chat/
 * run lists, history, and the generic MCP connection OAuth — is served by the
 * mounted handler. Same handler would mount in Hono/Next/serverless.
 */
const handle = async (request: Request) => {
  const { handler } = await getLatch();
  return (await handler(request)) ?? new Response("Not found", { status: 404 });
};

export const Route = createFileRoute("/api/latch/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
