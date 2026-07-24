import { createFileRoute } from "@tanstack/react-router";
import { getTelegramChannelForBot } from "@/lib/telegram-channel";

/**
 * Per-bot Telegram webhook. Each bot registers its own URL
 * (`/api/telegram/<botId>/events`) via `setWebhook`, so — unlike Slack's
 * shared route + `api_app_id` peek — the bot is identified by the path and
 * the channel verifies the request with that bot's own secret token.
 */
async function handleTelegram(request: Request, botId: string): Promise<Response> {
  if (!botId) return new Response("unknown bot", { status: 400 });
  const resolved = await getTelegramChannelForBot(botId);
  if (!resolved) return new Response("bot not registered", { status: 404 });
  return resolved.channel.handleRequest(request);
}

export const Route = createFileRoute("/api/telegram/$botId/events")({
  server: {
    handlers: {
      POST: ({ request, params }) => handleTelegram(request, params.botId),
    },
  },
});
