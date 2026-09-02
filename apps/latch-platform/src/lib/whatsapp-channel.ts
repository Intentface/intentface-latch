import { waitUntil } from "@vercel/functions";
import { whatsappChannel } from "@intentface/latch-channels/whatsapp";
import { getLatch } from "./latch";
import { whatsappVaultKeys } from "./channel-store";
import { dmIdentityGate } from "./channel-auth";
import { baseUrl } from "./base-url";
import type { Principal } from "./session";

/**
 * Build the WhatsApp channel for one bot (business number), mirroring
 * `telegram-channel.ts`: runtime + Vault + identity gate, turns run as the
 * linked user. Returns null if the bot isn't registered or is disabled.
 */
export async function getWhatsappChannelForBot(botId: string) {
  const { runtime, channelStore, credentials } = await getLatch();
  const bot = await channelStore.getBot("whatsapp", botId);
  if (!bot || bot.status !== "active") return null;

  const owner: Principal = { orgId: bot.orgId, userId: bot.userId };
  const keys = whatsappVaultKeys(botId);
  const cred = (key: string) => async () =>
    (await credentials.get(owner, key, "org")) ?? "";

  const gate = dmIdentityGate({ kind: "whatsapp", bot, channelStore });

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
      get: (chatId) => channelStore.getAsk(chatId),
      begin: (chatId, session) => channelStore.beginAsk(chatId, session),
      update: (chatId, toolCallId, rev, patch) =>
        channelStore.updateAsk(chatId, toolCallId, rev, patch),
      finish: (chatId, toolCallId, rev) => channelStore.finishAsk(chatId, toolCallId, rev),
      clear: (chatId) => channelStore.clearAsk(chatId),
    },
    // Which conversation this thread is writing to — what makes `/new` possible.
    thread: {
      current: (key) => channelStore.currentThread(key),
      rotate: (key) => channelStore.rotateThread(key),
    },
    waitUntil: (p) => waitUntil(p),
    seen: (key) => channelStore.seen("whatsapp", key),
    claimTurn: (chatId) => channelStore.claimTurn(chatId),
    releaseTurn: (chatId, token) => channelStore.releaseTurn(chatId, token),
    authorizeUser: ({ waId }) => gate(waId),
    stashPending: (input) =>
      channelStore.setPending("whatsapp", botId, input.waId, {
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
