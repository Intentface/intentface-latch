import { getLatch } from "./latch";
import { getTelegramChannelForBot } from "./telegram-channel";
import { getWhatsappChannelForBot } from "./whatsapp-channel";
import { getSlackChannelForApp } from "./slack-channel";
import type { ChannelKind } from "./channel-store";
import type { Principal } from "./session";

/**
 * What the one link route (`/link/$kind`) needs to know per channel: how to find
 * the binding a link belongs to, which identity row the link writes, where the
 * held message lives, how to describe the platform identity on the confirmation
 * page, and how to replay the held message once linked.
 */

export interface LinkReplayInput {
  botRef: string;
  meta: string;
  externalId: string;
  /** The binding the link resolved to (`binding()`'s `data`). */
  binding: unknown;
  /** The held message, as the channel stashed it. */
  pending: unknown;
  /** The Latch user who just linked (from the browser session). */
  userId: string;
  orgId: string;
}

export interface LinkKind {
  label: string;
  /** The binding a link belongs to — null when it no longer exists (or `meta` is unusable). */
  binding(botRef: string, meta: string): Promise<{ orgId: string; data: unknown } | null>;
  /** The identity row the link writes. */
  identityRef(botRef: string, meta: string, externalId: string): { botRef: string; externalId: string };
  /** Where the channel held the message that triggered the link. */
  pendingRef(botRef: string, meta: string, externalId: string): { botRef: string; externalId: string };
  /** The platform identity as shown on the confirmation page. */
  describe(externalId: string, meta: string): string;
  /** Replay the held message under the turn lease. */
  replay(input: LinkReplayInput): Promise<void>;
}

const sameRef = (botRef: string, _meta: string, externalId: string) => ({ botRef, externalId });

type TelegramPending = {
  telegramChatId: string;
  text: string;
  media?: { ref: { file_id: string }; mediaType: string; name: string }[];
};
type WhatsappPending = {
  text: string;
  media?: { ref: { id: string }; mediaType: string; name: string }[];
};
type SlackPending = { channel: string; threadRoot: string; anchorTs?: string; prompt: string };

export const LINK_KINDS: Record<ChannelKind, LinkKind> = {
  telegram: {
    label: "Telegram",
    binding: async (botRef) => {
      const bot = await (await getLatch()).channelStore.getBot("telegram", botRef);
      return bot ? { orgId: bot.orgId, data: bot } : null;
    },
    identityRef: sameRef,
    pendingRef: sameRef,
    describe: (externalId, meta) => (meta ? `@${meta} (id ${externalId})` : `user id ${externalId}`),
    replay: async ({ botRef, externalId, pending, userId, orgId }) => {
      const resolved = await getTelegramChannelForBot(botRef);
      if (!resolved) return;
      const p = pending as TelegramPending;
      await resolved.channel.replayMessage({
        telegramUserId: externalId,
        telegramChatId: p.telegramChatId,
        text: p.text,
        ...(p.media ? { media: p.media as never } : {}),
        principal: { orgId, userId },
      });
    },
  },

  whatsapp: {
    label: "WhatsApp",
    binding: async (botRef) => {
      const bot = await (await getLatch()).channelStore.getBot("whatsapp", botRef);
      return bot ? { orgId: bot.orgId, data: bot } : null;
    },
    identityRef: sameRef,
    pendingRef: sameRef,
    describe: (externalId) => `+${externalId}`,
    replay: async ({ botRef, externalId, pending, userId, orgId }) => {
      const resolved = await getWhatsappChannelForBot(botRef);
      if (!resolved) return;
      const p = pending as WhatsappPending;
      await resolved.channel.replayMessage({
        waId: externalId,
        text: p.text,
        ...(p.media ? { media: p.media as never } : {}),
        principal: { orgId, userId },
      });
    },
  },

  // Slack links carry the app id as `botRef` (the binding is keyed by app, and
  // `team_id` alone can't say which org owns it) and the team id as `meta` —
  // identities are per workspace, held messages per app.
  slack: {
    label: "Slack",
    binding: async (appId, teamId) => {
      if (!teamId) return null;
      const app = await (await getLatch()).slackStore.resolve(appId);
      return app ? { orgId: app.orgId, data: app } : null;
    },
    identityRef: (_appId, teamId, slackUserId) => ({ botRef: teamId, externalId: slackUserId }),
    pendingRef: (appId, teamId, slackUserId) => ({ botRef: appId, externalId: `${teamId}:${slackUserId}` }),
    describe: (slackUserId, teamId) => `user ${slackUserId} (workspace ${teamId})`,
    replay: async ({ botRef: appId, externalId: slackUserId, binding, pending, userId, orgId }) => {
      const resolved = await getSlackChannelForApp(appId);
      if (!resolved) return;
      const app = binding as { credentialMode?: string; userId?: string };
      const p = pending as SlackPending;
      // The replay is a turn on behalf of the human who JUST linked: carry them
      // as the actor, exactly as a live message from them would — otherwise the
      // very first thing a freshly linked member does runs on the binder's
      // grants. A 'shared' binding drops the actor, same as the live-message gate.
      const principal: Principal =
        app.credentialMode === "shared"
          ? { orgId, userId: app.userId }
          : { orgId, userId: app.userId, actorUserId: userId };
      await resolved.channel.runMessage({
        channel: p.channel,
        root: p.threadRoot,
        ...(p.anchorTs ? { anchorTs: p.anchorTs } : {}),
        userId: slackUserId,
        prompt: p.prompt,
        principal,
      });
    },
  },
};

/** `hasOwn`, not `in`: `/link/toString` must 404, not resolve Object.prototype as an adapter. */
export const isChannelKind = (s: string): s is ChannelKind => Object.hasOwn(LINK_KINDS, s);
