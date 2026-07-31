import type { Client } from "@libsql/client";
import { createChannelAskStore, migrateChannelAsk } from "./channel-ask-store";
import type { WaMediaRef } from "@intentface/latch-channels/whatsapp";

/**
 * Persistence for the WhatsApp channel (own-number-per-agent), mirroring
 * `telegram-store.ts`:
 *  - `latch_whatsapp_bot`      — one row per agent's WhatsApp business number.
 *    `phone_number_id` is mirrored here for display; the Meta credentials
 *    (access token, app secret, verify token) live in the Vault.
 *  - `latch_whatsapp_identity` — (bot, wa_id) → platform user link.
 *  - `latch_whatsapp_delivery` — handled `wamid` keys with a 10-min TTL.
 *  - `latch_whatsapp_pending`  — a message held while an unlinked user links.
 *  - `latch_channel_turn`      — shared with the Telegram store.
 *  - `latch_channel_ask`       — in-flight askUser questionnaires, also shared.
 */

const DELIVERY_TTL_MS = 10 * 60 * 1000;
const TURN_LEASE_MS = 5 * 60 * 1000;

export async function migrateWhatsapp(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_whatsapp_bot (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    agent_scope TEXT,
    org_id TEXT NOT NULL,
    user_id TEXT,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT,
    phone_number_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_whatsapp_identity (
    bot_id TEXT NOT NULL,
    wa_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    profile_name TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, wa_user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_whatsapp_delivery (
    key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_whatsapp_pending (
    bot_id TEXT NOT NULL,
    wa_user_id TEXT NOT NULL,
    profile_name TEXT,
    text TEXT NOT NULL,
    media TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, wa_user_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_turn (
    chat_id TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL
  )`);
  await migrateChannelAsk(client);
  // Idempotent adds for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  for (const [table, col] of [
    ["latch_whatsapp_bot", "agent_scope TEXT"],
    ["latch_whatsapp_pending", "media TEXT"],
    ["latch_channel_turn", "token TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    try {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
}

/** Vault credential key names for a WhatsApp bot's secrets (stored at org scope). */
export const whatsappVaultKeys = (botId: string) => ({
  accessToken: `whatsapp_access_token:${botId}`,
  phoneNumberId: `whatsapp_phone_number_id:${botId}`,
  appSecret: `whatsapp_app_secret:${botId}`,
  verifyToken: `whatsapp_verify_token:${botId}`,
});

export interface WhatsappBot {
  id: string;
  agent: string;
  /** Scope pin for agent resolution — see TelegramBot.agentScope. */
  agentScope?: "org" | "user";
  orgId: string;
  userId?: string;
  handle: string;
  displayName?: string;
  phoneNumberId?: string;
  status: "active" | "disabled";
}

/** A media attachment held with a pending message (Meta media ids stay valid ~30 days). */
export interface PendingWhatsappMedia {
  ref: WaMediaRef;
  mediaType: string;
  name: string;
}

function rowToBot(r: Record<string, unknown>): WhatsappBot {
  return {
    id: String(r.id),
    agent: String(r.agent),
    agentScope:
      r.agent_scope === "org" || r.agent_scope === "user" ? r.agent_scope : undefined,
    orgId: String(r.org_id),
    userId: r.user_id ? String(r.user_id) : undefined,
    handle: String(r.handle),
    displayName: r.display_name ? String(r.display_name) : undefined,
    phoneNumberId: r.phone_number_id ? String(r.phone_number_id) : undefined,
    status: r.status === "disabled" ? "disabled" : "active",
  };
}

export function createWhatsappStore(client: Client) {
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
        sql: `INSERT INTO latch_whatsapp_bot
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

    async get(id: string): Promise<WhatsappBot | null> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_whatsapp_bot WHERE id = ? LIMIT 1`,
        args: [id],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToBot(r) : null;
    },

    async listForOrg(orgId: string): Promise<WhatsappBot[]> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_whatsapp_bot WHERE org_id = ? ORDER BY created_at`,
        args: [orgId],
      });
      return res.rows.map((r) => rowToBot(r as Record<string, unknown>));
    },

    /** After a credentials save: mirror the validated phone number id for display. */
    async setPhoneNumberId(id: string, phoneNumberId: string): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_whatsapp_bot SET phone_number_id = ?, updated_at = ? WHERE id = ?`,
        args: [phoneNumberId, Date.now(), id],
      });
    },

    async setStatus(id: string, status: "active" | "disabled"): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_whatsapp_bot SET status = ?, updated_at = ? WHERE id = ?`,
        args: [status, Date.now(), id],
      });
    },

    async remove(id: string): Promise<void> {
      await client.execute({ sql: `DELETE FROM latch_whatsapp_bot WHERE id = ?`, args: [id] });
      await client.execute({
        sql: `DELETE FROM latch_whatsapp_identity WHERE bot_id = ?`,
        args: [id],
      });
      await client.execute({
        sql: `DELETE FROM latch_whatsapp_pending WHERE bot_id = ?`,
        args: [id],
      });
    },

    /**
     * Same conflict rule as Telegram: a link to a different user is refused.
     * Atomic insert-if-absent + user_id-fenced refresh (see telegram-store.ts).
     */
    async linkIdentity(input: {
      botId: string;
      waId: string;
      userId: string;
      orgId: string;
      profileName?: string;
    }): Promise<"linked" | "conflict"> {
      const inserted = await client.execute({
        sql: `INSERT INTO latch_whatsapp_identity
                (bot_id, wa_user_id, user_id, org_id, profile_name, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(bot_id, wa_user_id) DO NOTHING`,
        args: [
          input.botId,
          input.waId,
          input.userId,
          input.orgId,
          input.profileName ?? null,
          Date.now(),
        ],
      });
      if (inserted.rowsAffected === 1) return "linked";
      const refreshed = await client.execute({
        sql: `UPDATE latch_whatsapp_identity SET profile_name = ?, org_id = ?
              WHERE bot_id = ? AND wa_user_id = ? AND user_id = ?`,
        args: [input.profileName ?? null, input.orgId, input.botId, input.waId, input.userId],
      });
      return refreshed.rowsAffected === 1 ? "linked" : "conflict";
    },

    async resolveIdentity(
      botId: string,
      waId: string,
    ): Promise<{ userId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT user_id, org_id FROM latch_whatsapp_identity
              WHERE bot_id = ? AND wa_user_id = ? LIMIT 1`,
        args: [botId, waId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? { userId: String(r.user_id), orgId: String(r.org_id) } : null;
    },

    async seenDelivery(key: string): Promise<boolean> {
      const now = Date.now();
      await client.execute({
        sql: `DELETE FROM latch_whatsapp_delivery WHERE expires_at < ?`,
        args: [now],
      });
      const res = await client.execute({
        sql: `INSERT INTO latch_whatsapp_delivery (key, expires_at) VALUES (?, ?)
              ON CONFLICT(key) DO NOTHING`,
        args: [key, now + DELIVERY_TTL_MS],
      });
      return res.rowsAffected === 0;
    },

    async setPending(input: {
      botId: string;
      waId: string;
      profileName?: string;
      text: string;
      media?: PendingWhatsappMedia[];
    }): Promise<void> {
      await client.execute({
        sql: `INSERT INTO latch_whatsapp_pending
                (bot_id, wa_user_id, profile_name, text, media, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(bot_id, wa_user_id) DO UPDATE SET
                profile_name = excluded.profile_name, text = excluded.text,
                media = excluded.media, created_at = excluded.created_at`,
        args: [
          input.botId,
          input.waId,
          input.profileName ?? null,
          input.text,
          input.media?.length ? JSON.stringify(input.media) : null,
          Date.now(),
        ],
      });
    },

    async takePending(
      botId: string,
      waId: string,
    ): Promise<{ text: string; media?: PendingWhatsappMedia[] } | null> {
      const res = await client.execute({
        sql: `SELECT text, media FROM latch_whatsapp_pending
              WHERE bot_id = ? AND wa_user_id = ? LIMIT 1`,
        args: [botId, waId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      await client.execute({
        sql: `DELETE FROM latch_whatsapp_pending WHERE bot_id = ? AND wa_user_id = ?`,
        args: [botId, waId],
      });
      let media: PendingWhatsappMedia[] | undefined;
      try {
        media = r.media ? (JSON.parse(String(r.media)) as PendingWhatsappMedia[]) : undefined;
      } catch {
        media = undefined; // corrupt media never blocks the text replay
      }
      return { text: String(r.text), media };
    },

    /** Token-fenced one-turn-per-chat lease — see telegram-store.ts claimTurn. */
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
  };
}

export type WhatsappStore = ReturnType<typeof createWhatsappStore>;
