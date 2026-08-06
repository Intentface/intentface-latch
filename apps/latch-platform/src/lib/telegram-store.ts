import type { Client } from "@libsql/client";
import { createChannelAskStore, migrateChannelAsk } from "./channel-ask-store";
import { createChannelThreadStore, migrateChannelThread } from "./channel-thread-store";
import type { TgFileRef } from "@intentface/latch-channels/telegram";

/**
 * Persistence for the Telegram channel (own-bot-per-agent):
 *  - `latch_telegram_bot`      — one row per agent's dedicated BotFather bot:
 *    maps our bot id → the agent + owning org. The bot token + webhook secret
 *    live in the Vault (keyed by bot id), not here.
 *  - `latch_telegram_identity` — (bot, Telegram user) → platform user link.
 *  - `latch_telegram_delivery` — handled delivery keys with a 10-min TTL
 *    (Telegram re-delivers updates until a 2xx; prune-then-check).
 *  - `latch_telegram_pending`  — a message held while an unlinked user links,
 *    replayed after they link.
 *  - `latch_channel_turn`      — one-turn-per-chat leases, shared with the
 *    WhatsApp store (chat ids are channel-prefixed so keys never collide).
 *  - `latch_channel_ask`       — the in-flight askUser questionnaire per chat
 *    (also channel-shared), holding answers collected so far.
 *  - `latch_channel_thread`    — which conversation a DM is currently writing to
 *    (also channel-shared); `/new` bumps it.
 *
 * Idempotent create-if-not-exists, same pattern as `migrateSlack`.
 */

const DELIVERY_TTL_MS = 10 * 60 * 1000;
const TURN_LEASE_MS = 5 * 60 * 1000;

export async function migrateTelegram(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_telegram_bot (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    agent_scope TEXT,
    org_id TEXT NOT NULL,
    user_id TEXT,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT,
    bot_username TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    webhook_registered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_telegram_identity (
    bot_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    username TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, telegram_user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_telegram_delivery (
    key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_telegram_pending (
    bot_id TEXT NOT NULL,
    telegram_user_id TEXT NOT NULL,
    telegram_chat_id TEXT NOT NULL,
    username TEXT,
    text TEXT NOT NULL,
    media TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, telegram_user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_turn (
    chat_id TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL
  )`);
  await migrateChannelAsk(client);
  await migrateChannelThread(client);
  // Idempotent adds for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  for (const [table, col] of [
    ["latch_telegram_bot", "agent_scope TEXT"],
    ["latch_telegram_pending", "media TEXT"],
    ["latch_channel_turn", "token TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

/** Vault credential key names for a Telegram bot's secrets (stored at org scope). */
export const telegramVaultKeys = (botId: string) => ({
  botToken: `telegram_bot_token:${botId}`,
  webhookSecret: `telegram_webhook_secret:${botId}`,
});

export interface TelegramBot {
  id: string;
  agent: string;
  /**
   * The scope the bound agent record had at binding time — webhook turns pin
   * resolution to it (`org:`/`user:` prefixed names, see agent-store.ts) so a
   * same-named personal agent can never shadow an org binding (and vice
   * versa). Undefined = a code-registry agent (unambiguous by construction).
   */
  agentScope?: "org" | "user";
  orgId: string;
  userId?: string;
  handle: string;
  displayName?: string;
  botUsername?: string;
  status: "active" | "disabled";
  webhookRegisteredAt?: number;
}

/** A media attachment held with a pending message (Telegram file refs stay downloadable). */
export interface PendingTelegramMedia {
  ref: TgFileRef;
  mediaType: string;
  name: string;
}

function rowToBot(r: Record<string, unknown>): TelegramBot {
  return {
    id: String(r.id),
    agent: String(r.agent),
    agentScope:
      r.agent_scope === "org" || r.agent_scope === "user" ? r.agent_scope : undefined,
    orgId: String(r.org_id),
    userId: r.user_id ? String(r.user_id) : undefined,
    handle: String(r.handle),
    displayName: r.display_name ? String(r.display_name) : undefined,
    botUsername: r.bot_username ? String(r.bot_username) : undefined,
    status: r.status === "disabled" ? "disabled" : "active",
    webhookRegisteredAt:
      typeof r.webhook_registered_at === "number" && r.webhook_registered_at
        ? r.webhook_registered_at
        : r.webhook_registered_at
          ? Number(r.webhook_registered_at)
          : undefined,
  };
}

export function createTelegramStore(client: Client) {
  return {
    async create(bot: {
      id: string;
      agent: string;
      agentScope?: "org" | "user";
      orgId: string;
      userId?: string;
      handle: string;
      displayName?: string;
    }): Promise<void> {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_telegram_bot
                (id, agent, agent_scope, org_id, user_id, handle, display_name, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [
          bot.id,
          bot.agent,
          bot.agentScope ?? null,
          bot.orgId,
          bot.userId ?? null,
          bot.handle,
          bot.displayName ?? null,
          now,
          now,
        ],
      });
    },

    async get(id: string): Promise<TelegramBot | null> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_telegram_bot WHERE id = ? LIMIT 1`,
        args: [id],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToBot(r) : null;
    },

    async listForOrg(orgId: string): Promise<TelegramBot[]> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_telegram_bot WHERE org_id = ? ORDER BY created_at`,
        args: [orgId],
      });
      return res.rows.map((r) => rowToBot(r as Record<string, unknown>));
    },

    /** After a token save: record the validated bot @username, reset the webhook mark. */
    async setBotUsername(id: string, botUsername: string): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_telegram_bot
              SET bot_username = ?, webhook_registered_at = NULL, updated_at = ?
              WHERE id = ?`,
        args: [botUsername, Date.now(), id],
      });
    },

    async markWebhookRegistered(id: string): Promise<void> {
      const now = Date.now();
      await client.execute({
        sql: `UPDATE latch_telegram_bot SET webhook_registered_at = ?, updated_at = ? WHERE id = ?`,
        args: [now, now, id],
      });
    },

    async setStatus(id: string, status: "active" | "disabled"): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_telegram_bot SET status = ?, updated_at = ? WHERE id = ?`,
        args: [status, Date.now(), id],
      });
    },

    async remove(id: string): Promise<void> {
      await client.execute({ sql: `DELETE FROM latch_telegram_bot WHERE id = ?`, args: [id] });
      await client.execute({
        sql: `DELETE FROM latch_telegram_identity WHERE bot_id = ?`,
        args: [id],
      });
      await client.execute({
        sql: `DELETE FROM latch_telegram_pending WHERE bot_id = ?`,
        args: [id],
      });
      // Per-chat state in the channel-shared tables is keyed by chat id, which
      // embeds the bot id (`telegram_<botId>_<userId>`) — drop those rows too, or
      // deleting a binding leaves its thread pointers and half-answered
      // questionnaires behind forever. Matched with `substr` rather than LIKE:
      // `_` is a LIKE wildcard and these keys are full of underscores.
      const prefix = `telegram_${id}_`;
      for (const table of ["latch_channel_thread", "latch_channel_ask", "latch_channel_turn"]) {
        const column = table === "latch_channel_thread" ? "chat_key" : "chat_id";
        await client.execute({
          sql: `DELETE FROM ${table} WHERE substr(${column}, 1, ?) = ?`,
          args: [prefix.length, prefix],
        });
      }
    },

    /**
     * Link a Telegram user to a platform user. An existing link to a DIFFERENT
     * platform user is refused ("conflict") — re-linking must be deliberate;
     * the same user re-linking just refreshes the cached username. Atomic:
     * insert-if-absent, then a user_id-fenced update — two accounts opening
     * the same link concurrently can never overwrite each other.
     */
    async linkIdentity(input: {
      botId: string;
      telegramUserId: string;
      userId: string;
      orgId: string;
      username?: string;
    }): Promise<"linked" | "conflict"> {
      const inserted = await client.execute({
        sql: `INSERT INTO latch_telegram_identity
                (bot_id, telegram_user_id, user_id, org_id, username, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(bot_id, telegram_user_id) DO NOTHING`,
        args: [
          input.botId,
          input.telegramUserId,
          input.userId,
          input.orgId,
          input.username ?? null,
          Date.now(),
        ],
      });
      if (inserted.rowsAffected === 1) return "linked";
      const refreshed = await client.execute({
        sql: `UPDATE latch_telegram_identity SET username = ?, org_id = ?
              WHERE bot_id = ? AND telegram_user_id = ? AND user_id = ?`,
        args: [
          input.username ?? null,
          input.orgId,
          input.botId,
          input.telegramUserId,
          input.userId,
        ],
      });
      return refreshed.rowsAffected === 1 ? "linked" : "conflict";
    },

    /** The platform user linked to a (bot, Telegram user), or null if unlinked. */
    async resolveIdentity(
      botId: string,
      telegramUserId: string,
    ): Promise<{ userId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT user_id, org_id FROM latch_telegram_identity
              WHERE bot_id = ? AND telegram_user_id = ? LIMIT 1`,
        args: [botId, telegramUserId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? { userId: String(r.user_id), orgId: String(r.org_id) } : null;
    },

    /**
     * The reverse of `resolveIdentity`: which Telegram user a platform user is
     * linked to on this bot, or null if they never linked. Needed by anything
     * that starts a conversation FROM our side (a scheduled run pushing into
     * the DM) — the inbound path always learns the Telegram user from the
     * update, but an outbound one only knows the platform principal.
     */
    async identityForUser(
      botId: string,
      userId: string,
    ): Promise<{ telegramUserId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT telegram_user_id, org_id FROM latch_telegram_identity
              WHERE bot_id = ? AND user_id = ? LIMIT 1`,
        args: [botId, userId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r
        ? { telegramUserId: String(r.telegram_user_id), orgId: String(r.org_id) }
        : null;
    },

    /** The org's active bots bound to one agent (for delivery-target pickers). */
    async botsForAgent(orgId: string, agent: string): Promise<TelegramBot[]> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_telegram_bot
              WHERE org_id = ? AND agent = ? AND status = 'active'
              ORDER BY created_at`,
        args: [orgId, agent],
      });
      return res.rows.map((r) => rowToBot(r as Record<string, unknown>));
    },

    /**
     * Mark a delivery key as handled; returns true if it was ALREADY seen (so
     * the caller should drop it). Prune-then-check with a 10-min TTL.
     */
    async seenDelivery(key: string): Promise<boolean> {
      const now = Date.now();
      await client.execute({
        sql: `DELETE FROM latch_telegram_delivery WHERE expires_at < ?`,
        args: [now],
      });
      const res = await client.execute({
        sql: `INSERT INTO latch_telegram_delivery (key, expires_at) VALUES (?, ?)
              ON CONFLICT(key) DO NOTHING`,
        args: [key, now + DELIVERY_TTL_MS],
      });
      return res.rowsAffected === 0;
    },

    /** Hold the message that triggered a link prompt, to replay after linking. */
    async setPending(input: {
      botId: string;
      telegramUserId: string;
      telegramChatId: string;
      username?: string;
      text: string;
      media?: PendingTelegramMedia[];
    }): Promise<void> {
      await client.execute({
        sql: `INSERT INTO latch_telegram_pending
                (bot_id, telegram_user_id, telegram_chat_id, username, text, media, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(bot_id, telegram_user_id) DO UPDATE SET
                telegram_chat_id = excluded.telegram_chat_id,
                username = excluded.username, text = excluded.text,
                media = excluded.media, created_at = excluded.created_at`,
        args: [
          input.botId,
          input.telegramUserId,
          input.telegramChatId,
          input.username ?? null,
          input.text,
          input.media?.length ? JSON.stringify(input.media) : null,
          Date.now(),
        ],
      });
    },

    /** Fetch and clear a held message (replay-once). */
    async takePending(
      botId: string,
      telegramUserId: string,
    ): Promise<{ telegramChatId: string; text: string; media?: PendingTelegramMedia[] } | null> {
      const res = await client.execute({
        sql: `SELECT telegram_chat_id, text, media FROM latch_telegram_pending
              WHERE bot_id = ? AND telegram_user_id = ? LIMIT 1`,
        args: [botId, telegramUserId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      await client.execute({
        sql: `DELETE FROM latch_telegram_pending WHERE bot_id = ? AND telegram_user_id = ?`,
        args: [botId, telegramUserId],
      });
      let media: PendingTelegramMedia[] | undefined;
      try {
        media = r.media ? (JSON.parse(String(r.media)) as PendingTelegramMedia[]) : undefined;
      } catch {
        media = undefined; // corrupt media never blocks the text replay
      }
      return { telegramChatId: String(r.telegram_chat_id), text: String(r.text), media };
    },

    /**
     * One-turn-per-chat lease; expired leases are reclaimed (crash safety).
     * Returns a claimant token, or null when the chat's turn is taken. The
     * release is fenced on the token: a turn that outlives its 5-min lease
     * can't delete the lease a NEWER turn now holds.
     */
    async claimTurn(chatId: string): Promise<string | null> {
      const now = Date.now();
      await client.execute({
        sql: `DELETE FROM latch_channel_turn WHERE expires_at < ?`,
        args: [now],
      });
      const token = crypto.randomUUID();
      const res = await client.execute({
        sql: `INSERT INTO latch_channel_turn (chat_id, token, expires_at) VALUES (?, ?, ?)
              ON CONFLICT(chat_id) DO NOTHING`,
        args: [chatId, token, now + TURN_LEASE_MS],
      });
      return res.rowsAffected === 1 ? token : null;
    },

    async releaseTurn(chatId: string, token: string): Promise<void> {
      await client.execute({
        sql: `DELETE FROM latch_channel_turn WHERE chat_id = ? AND token = ?`,
        args: [chatId, token],
      });
    },

    ...createChannelAskStore(client),
    ...createChannelThreadStore(client),
  };
}

export type TelegramStore = ReturnType<typeof createTelegramStore>;
