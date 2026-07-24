import { createFileRoute } from "@tanstack/react-router";
import { getWhatsappChannelForBot } from "@/lib/whatsapp-channel";

/**
 * Per-bot WhatsApp (Meta Cloud API) webhook. GET is Meta's verify handshake
 * (`hub.challenge`, fired when the callback URL is saved in the dashboard);
 * POST carries events, HMAC-verified by the channel with the bot's app secret.
 */
async function handleWhatsapp(request: Request, botId: string): Promise<Response> {
  if (!botId) return new Response("unknown bot", { status: 400 });
  const resolved = await getWhatsappChannelForBot(botId);
  if (!resolved) return new Response("bot not registered", { status: 404 });
  return resolved.channel.handleRequest(request);
}

export const Route = createFileRoute("/api/whatsapp/$botId/events")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleWhatsapp(request, params.botId),
      POST: ({ request, params }) => handleWhatsapp(request, params.botId),
    },
  },
});
