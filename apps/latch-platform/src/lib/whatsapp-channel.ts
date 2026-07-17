import { waitUntil } from "@vercel/functions";
import { whatsappChannel } from "@intentface/latch-channels/whatsapp";
import { getLatch } from "./latch";
import { whatsappVaultKeys, type WhatsappBot } from "./whatsapp-store";
import { buildWhatsappLinkUrl } from "./whatsapp-link";
import { baseUrl } from "./base-url";
import type { Principal } from "./session";

/**
 * Build the WhatsApp channel for one bot (business number), mirroring
 * `telegram-channel.ts`: runtime + Vault + identity gate, turns run as the
 * linked user. Returns null if the bot isn't registered or is disabled.
 */
export async function getWhatsappChannelForBot(botId: string) {
  const { runtime, whatsappStore, credentials } = await getLatch();
  const bot = await whatsappStore.get(botId);
  if (!bot || bot.status !== "active") return null;

  const owner: Principal = { orgId: bot.orgId, userId: bot.userId };
  const keys = whatsappVaultKeys(botId);
  const cred = (key: string) => async () =>
    (await credentials.get(owner, key, "org")) ?? "";

  const channel = whatsappChannel<Principal>({
    agent: bot.agent,
    botRef: botId,
    accessToken: cred(keys.accessToken),
    phoneNumberId: cred(keys.phoneNumberId),
    appSecret: cred(keys.appSecret),
    verifyToken: cred(keys.verifyToken),
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    waitUntil: (p) => waitUntil(p),
    seen: (key) => whatsappStore.seenDelivery(key),
    claimTurn: (chatId) => whatsappStore.claimTurn(chatId),
    releaseTurn: (chatId) => whatsappStore.releaseTurn(chatId),
    authorizeUser: async ({ waId }) => {
      const identity = await whatsappStore.resolveIdentity(botId, waId);
      if (identity) {
        return { allowed: true, principal: { orgId: bot.orgId, userId: identity.userId } };
      }
      return {
        allowed: false,
        message: "You need a Latch account to use this agent.",
        linkUrl: buildWhatsappLinkUrl(baseUrl(), botId, waId),
      };
    },
    stashPending: (input) =>
      whatsappStore.setPending({
        botId,
        waId: input.waId,
        profileName: input.profileName,
        text: input.text,
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

  return { channel, bot: bot as WhatsappBot };
}
