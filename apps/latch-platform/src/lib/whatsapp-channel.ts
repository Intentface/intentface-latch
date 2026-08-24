import { waitUntil } from "@vercel/functions";
import { whatsappChannel } from "@intentface/latch-channels/whatsapp";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { whatsappVaultKeys } from "./whatsapp-store";
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
    // Scope-pinned agent ref — see telegram-channel.ts.
    agent: bot.agentScope ? `${bot.agentScope}:${bot.agent}` : bot.agent,
    botRef: botId,
    accessToken: cred(keys.accessToken),
    phoneNumberId: cred(keys.phoneNumberId),
    appSecret: cred(keys.appSecret),
    verifyToken: cred(keys.verifyToken),
    runtime: {
      handleChat: (i) => runtime.handleChat(i),
      applyApproval: (i) => runtime.applyApproval(i),
      // Resumes a turn parked on `askUser` — makes questionnaires answerable here.
      applyToolResult: (i) => runtime.applyToolResult(i),
      loadHistory: (i) => runtime.loadHistory(i),
    },
    // Holds the answers collected so far while a questionnaire is on screen.
    askState: {
      get: (chatId) => whatsappStore.getAsk(chatId),
      begin: (chatId, session) => whatsappStore.beginAsk(chatId, session),
      update: (chatId, toolCallId, rev, patch) =>
        whatsappStore.updateAsk(chatId, toolCallId, rev, patch),
      finish: (chatId, toolCallId, rev) => whatsappStore.finishAsk(chatId, toolCallId, rev),
      clear: (chatId) => whatsappStore.clearAsk(chatId),
    },
    waitUntil: (p) => waitUntil(p),
    seen: (key) => whatsappStore.seenDelivery(key),
    claimTurn: (chatId) => whatsappStore.claimTurn(chatId),
    releaseTurn: (chatId, token) => whatsappStore.releaseTurn(chatId, token),
    authorizeUser: async ({ waId }) => {
      const identity = await whatsappStore.resolveIdentity(botId, waId);
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
        linkUrl: buildWhatsappLinkUrl(baseUrl(), botId, waId),
      };
    },
    stashPending: (input) =>
      whatsappStore.setPending({
        botId,
        waId: input.waId,
        profileName: input.profileName,
        text: input.text,
        media: input.media,
      }),
    authorizeUrl: (name, ctx) => {
      const q = new URLSearchParams({
        chatId: ctx.chatId,
        approvalId: ctx.approvalId,
        // RELATIVE: the callback's open-redirect guard rejects absolute
        // URLs and lands the user on `/` instead of their chat.
        returnTo: `/chat/${ctx.chatId}`,
      });
      return `${baseUrl()}/api/latch/connections/${name}/authorize?${q}`;
    },
  });

  return { channel, bot: bot };
}
