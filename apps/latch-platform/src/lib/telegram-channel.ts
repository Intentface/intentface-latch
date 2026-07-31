import { waitUntil } from "@vercel/functions";
import { telegramChannel } from "@intentface/latch-channels/telegram";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { telegramVaultKeys, type TelegramBot } from "./telegram-store";
import { buildTelegramLinkUrl } from "./telegram-link";
import { baseUrl } from "./base-url";
import { transcribeAudio } from "./transcribe";
import type { Principal } from "./session";

/**
 * Build the Telegram channel for one bot (resolved by our bot id from the
 * per-bot webhook URL), wired to the runtime + Vault + identity gate. Shared
 * by the webhook route and the post-link resume. Returns null if the bot
 * isn't registered or is disabled.
 *
 * Unlike Slack (which runs every turn as the app's owner), turns run as the
 * LINKED user: `authorizeUser` resolves the (bot, Telegram user) identity to
 * `{ orgId: bot.orgId, userId }`, so isolation is per (org, user).
 */
export async function getTelegramChannelForBot(botId: string) {
  const { runtime, telegramStore, credentials } = await getLatch();
  const bot = await telegramStore.get(botId);
  if (!bot || bot.status !== "active") return null;

  // Org-scope vault reads use the owner principal (userId stripped by scope).
  const owner: Principal = { orgId: bot.orgId, userId: bot.userId };
  const keys = telegramVaultKeys(botId);

  const channel = telegramChannel<Principal>({
    // Scope-pinned agent ref (agent-store.ts): the binding runs the record it
    // was created for — a linked member's same-named personal agent can never
    // shadow an org binding. Unpinned = code-registry agent.
    agent: bot.agentScope ? `${bot.agentScope}:${bot.agent}` : bot.agent,
    botRef: botId,
    botToken: async () => (await credentials.get(owner, keys.botToken, "org")) ?? "",
    webhookSecret: async () => (await credentials.get(owner, keys.webhookSecret, "org")) ?? "",
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    waitUntil: (p) => waitUntil(p),
    // Voice/audio messages reach the agent as transcribed text (ElevenLabs).
    transcribe: ({ bytes, mediaType, filename }) =>
      // fresh copy pins the buffer type to ArrayBuffer (BlobPart rejects ArrayBufferLike)
      transcribeAudio({ audio: new Blob([new Uint8Array(bytes)], { type: mediaType }), filename }),
    seen: (key) => telegramStore.seenDelivery(key),
    claimTurn: (chatId) => telegramStore.claimTurn(chatId),
    releaseTurn: (chatId, token) => telegramStore.releaseTurn(chatId, token),
    // Only linked platform users may drive the agent; refusals get a signed
    // link, and the triggering message is stashed for post-link replay.
    authorizeUser: async ({ telegramUserId, username }) => {
      const identity = await telegramStore.resolveIdentity(botId, telegramUserId);
      if (identity) {
        // Identity rows outlive org membership — revalidate before minting a
        // principal, or a removed member keeps channel access to org agents.
        if (!(await isOrgMember(identity.userId, bot.orgId))) {
          return {
            allowed: false,
            message: "Your Latch account is no longer a member of this agent's organization.",
          };
        }
        // A personal-agent binding resolves the CREATOR's record; any other
        // member would resolve their own same-named agent (or nothing).
        if (bot.agentScope === "user" && identity.userId !== bot.userId) {
          return {
            allowed: false,
            message: "This bot serves a personal agent — only its owner can use it.",
          };
        }
        return { allowed: true, principal: { orgId: bot.orgId, userId: identity.userId } };
      }
      return {
        allowed: false,
        message: "You need a Latch account to use this agent.",
        linkUrl: buildTelegramLinkUrl(baseUrl(), botId, telegramUserId, username),
      };
    },
    stashPending: (input) =>
      telegramStore.setPending({
        botId,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        username: input.username,
        text: input.text,
        media: input.media,
      }),
    authorizeUrl: (name, ctx) => {
      const q = new URLSearchParams({
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        returnTo: `${baseUrl()}/chat/${ctx.chatId}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return { channel, bot: bot as TelegramBot };
}
