import type { Client } from "@libsql/client";
import { createChannelAskStore, migrateChannelAsk } from "./channel-ask-store";
import { createChannelThreadStore, migrateChannelThread } from "./channel-thread-store";

/**
 * One store for everything the chat channels persist that isn't
 * platform-specific — the pieces Telegram, WhatsApp and Slack each used to keep
 * in their own tables with their own column names:
 *
 *  - `latch_channel_bot`      — one row per DM bot (Telegram bot, WhatsApp number),
 *    keyed `(kind, id)`: the agent it serves, the owning org, the operator's
 *    handle, the platform-side handle (bot @username / phone-number id) and
 *    status. Credentials live in the Vault, never here. Slack apps stay in
 *    `latch_slack_app`: they carry a dozen Slack-only columns.
 *  - `latch_channel_identity` — `(kind, bot_ref, external_id)` → platform user.
 *    For DM bots `bot_ref` is the bot id; for Slack it is the workspace (team).
 *  - `latch_channel_pending`  — a message held while an unlinked user links,
 *    replayed once after they do. The payload is the channel's own JSON.
 *  - `latch_channel_dedupe`   — TTL'd test-and-set keys: webhook redeliveries,
 *    Slack's event/message/interaction claims, single-use OAuth states.
 *  - `latch_channel_turn`     — one-turn-per-chat leases.
 *  - `latch_channel_ask`      — the in-flight `askUser` questionnaire per chat.
 *  - `latch_channel_thread`   — which conversation a DM is writing to (`/new`).
 *
 * Chat ids are channel-prefixed (`telegram_<bot>_<user>`, `slack2_<app>_…`), so
 * the per-chat tables can't collide across kinds.
 *
 * `migrateChannels` also carries the legacy per-channel tables over — copy
 * then drop, in one batch per table so a failed copy leaves the legacy data
 * where it was — and is idempotent.
 */

export type ChannelKind = "telegram" | "whatsapp" | "slack";

const DELIVERY_TTL_MS = 10 * 60 * 1000;
const TURN_LEASE_MS = 5 * 60 * 1000;
/** Pendings outlive the longest link URL (Slack's 30 min); stale ones are never replayed. */
const PENDING_TTL_MS = 30 * 60 * 1000;

/** Vault credential key names for a Telegram bot's secrets (stored at org scope). */
export const telegramVaultKeys = (botId: string) => ({
  botToken: `telegram_bot_token:${botId}`,
  webhookSecret: `telegram_webhook_secret:${botId}`,
});

/** Vault credential key names for a WhatsApp bot's secrets (stored at org scope). */
export const whatsappVaultKeys = (botId: string) => ({
  accessToken: `whatsapp_access_token:${botId}`,
  phoneNumberId: `whatsapp_phone_number_id:${botId}`,
  appSecret: `whatsapp_app_secret:${botId}`,
  verifyToken: `whatsapp_verify_token:${botId}`,
});

export interface ChannelBot {
  kind: ChannelKind;
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
  /** The operator's own label for the binding; unique per kind. */
  handle: string;
  displayName?: string;
  /** The platform's handle once credentials were validated: bot @username, phone-number id. */
  externalHandle?: string;
  status: "active" | "disabled";
  webhookRegisteredAt?: number;
}

const num = (v: unknown): number | undefined => (v ? Number(v) : undefined);

function rowToBot(r: Record<string, unknown>): ChannelBot {
  return {
    kind: r.kind as ChannelKind,
    id: String(r.id),
    agent: String(r.agent),
    ...(r.agent_scope === "org" || r.agent_scope === "user" ? { agentScope: r.agent_scope } : {}),
    orgId: String(r.org_id),
    ...(r.user_id ? { userId: String(r.user_id) } : {}),
    handle: String(r.handle),
    ...(r.display_name ? { displayName: String(r.display_name) } : {}),
    ...(r.external_handle ? { externalHandle: String(r.external_handle) } : {}),
    status: r.status === "disabled" ? "disabled" : "active",
    ...(num(r.webhook_registered_at) ? { webhookRegisteredAt: num(r.webhook_registered_at) } : {}),
  };
}

// ── Schema + migration ───────────────────────────────────────────────────────

async function tableExists(client: Client, name: string): Promise<boolean> {
  const res = await client.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    args: [name],
  });
  return res.rows.length > 0;
}

/**
 * Copy one legacy table into the shared schema and drop it, atomically. A copy
 * that fails (a row the shared schema refuses, a JSON column that won't parse)
 * aborts the batch and leaves the legacy table — and its data — in place for a
 * human to look at; startup carries on either way.
 */
async function carryOver(client: Client, legacy: string, copy: string[]): Promise<void> {
  if (!(await tableExists(client, legacy))) return;
  try {
    await client.batch([...copy, `DROP TABLE ${legacy}`], "write");
    console.log(`[channels] migrated ${legacy} into the shared channel tables`);
  } catch (e) {
    console.error(`[channels] carry-over of ${legacy} failed — legacy table kept:`, e);
  }
}

export async function migrateChannels(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_bot (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    agent TEXT NOT NULL,
    agent_scope TEXT,
    org_id TEXT NOT NULL,
    user_id TEXT,
    handle TEXT NOT NULL,
    display_name TEXT,
    external_handle TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    webhook_registered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, id),
    UNIQUE (kind, handle)
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_channel_bot_org ON latch_channel_bot(kind, org_id, agent)`,
  );
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_identity (
    kind TEXT NOT NULL,
    bot_ref TEXT NOT NULL,
    external_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, bot_ref, external_id)
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_channel_identity_user ON latch_channel_identity(kind, bot_ref, user_id)`,
  );
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_pending (
    kind TEXT NOT NULL,
    bot_ref TEXT NOT NULL,
    external_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (kind, bot_ref, external_id)
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_dedupe (
    key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_channel_dedupe_exp ON latch_channel_dedupe(expires_at)`,
  );
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_turn (
    chat_id TEXT PRIMARY KEY,
    token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL
  )`);
  try {
    await client.execute(`ALTER TABLE latch_channel_turn ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
  } catch {
    /* column already exists */
  }
  await migrateChannelAsk(client);
  await migrateChannelThread(client);

  // ── Legacy per-channel tables → shared tables (copy, then drop) ────────────
  const bots = (kind: ChannelKind, table: string, externalHandle: string, webhook: string) =>
    `INSERT OR IGNORE INTO latch_channel_bot
       (kind, id, agent, agent_scope, org_id, user_id, handle, display_name, external_handle,
        status, webhook_registered_at, created_at, updated_at)
     SELECT '${kind}', id, agent, agent_scope, org_id, user_id, handle, display_name, ${externalHandle},
            status, ${webhook}, created_at, updated_at FROM ${table}`;
  const identities = (kind: ChannelKind, table: string, botRef: string, externalId: string, label: string) =>
    `INSERT OR IGNORE INTO latch_channel_identity
       (kind, bot_ref, external_id, user_id, org_id, label, created_at)
     SELECT '${kind}', ${botRef}, ${externalId}, user_id, org_id, ${label}, created_at FROM ${table}`;
  const dedupe = (kind: ChannelKind, table: string) =>
    `INSERT OR IGNORE INTO latch_channel_dedupe (key, expires_at)
     SELECT '${kind}:' || key, expires_at FROM ${table}`;

  await carryOver(client, "latch_telegram_bot", [
    bots("telegram", "latch_telegram_bot", "bot_username", "webhook_registered_at"),
  ]);
  await carryOver(client, "latch_telegram_identity", [
    identities("telegram", "latch_telegram_identity", "bot_id", "telegram_user_id", "username"),
  ]);
  await carryOver(client, "latch_telegram_pending", [
    `INSERT OR IGNORE INTO latch_channel_pending
       (kind, bot_ref, external_id, payload, expires_at, created_at)
     SELECT 'telegram', bot_id, telegram_user_id,
            json_object('telegramChatId', telegram_chat_id, 'username', username, 'text', text,
                        'media', json(media)),
            created_at + ${PENDING_TTL_MS}, created_at
     FROM latch_telegram_pending`,
  ]);
  await carryOver(client, "latch_telegram_delivery", [dedupe("telegram", "latch_telegram_delivery")]);

  await carryOver(client, "latch_whatsapp_bot", [
    bots("whatsapp", "latch_whatsapp_bot", "phone_number_id", "NULL"),
  ]);
  await carryOver(client, "latch_whatsapp_identity", [
    identities("whatsapp", "latch_whatsapp_identity", "bot_id", "wa_user_id", "profile_name"),
  ]);
  await carryOver(client, "latch_whatsapp_pending", [
    `INSERT OR IGNORE INTO latch_channel_pending
       (kind, bot_ref, external_id, payload, expires_at, created_at)
     SELECT 'whatsapp', bot_id, wa_user_id,
            json_object('profileName', profile_name, 'text', text, 'media', json(media)),
            created_at + ${PENDING_TTL_MS}, created_at
     FROM latch_whatsapp_pending`,
  ]);
  await carryOver(client, "latch_whatsapp_delivery", [dedupe("whatsapp", "latch_whatsapp_delivery")]);

  // Slack: identities are keyed by workspace, pendings by app (a workspace can
  // host two apps), dedupe keys already carry the app id.
  await carryOver(client, "latch_slack_identity", [
    identities("slack", "latch_slack_identity", "team_id", "slack_user_id", "NULL"),
  ]);
  await carryOver(client, "latch_slack_pending2", [
    `INSERT OR IGNORE INTO latch_channel_pending
       (kind, bot_ref, external_id, payload, expires_at, created_at)
     SELECT 'slack', app_id, team_id || ':' || slack_user_id,
            json_object('channel', channel, 'threadRoot', thread_root, 'anchorTs', anchor_ts,
                        'prompt', prompt),
            expires_at, created_at
     FROM latch_slack_pending2`,
  ]);
  await carryOver(client, "latch_slack_dedupe", [dedupe("slack", "latch_slack_dedupe")]);
  // Superseded long ago (grow-forever event log; the pre-app-keyed pending table).
  await carryOver(client, "latch_slack_event", []);
  await carryOver(client, "latch_slack_pending", []);
}

// ── The store ────────────────────────────────────────────────────────────────

export function createChannelStore(client: Client) {
  /** Atomic TTL'd test-and-set: TRUE when THIS call claimed the key. Prunes on the way in. */
  async function claimOnce(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    await client.execute({
      sql: `DELETE FROM latch_channel_dedupe WHERE expires_at < ?`,
      args: [now],
    });
    const res = await client.execute({
      sql: `INSERT INTO latch_channel_dedupe (key, expires_at) VALUES (?, ?)
            ON CONFLICT(key) DO NOTHING`,
      args: [key, now + ttlMs],
    });
    return res.rowsAffected === 1;
  }

  return {
    // ── Bots (Telegram bots, WhatsApp numbers) ───────────────────────────────

    async createBot(bot: {
      kind: ChannelKind;
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
        sql: `INSERT INTO latch_channel_bot
                (kind, id, agent, agent_scope, org_id, user_id, handle, display_name, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [
          bot.kind,
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

    async getBot(kind: ChannelKind, id: string): Promise<ChannelBot | null> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_bot WHERE kind = ? AND id = ? LIMIT 1`,
        args: [kind, id],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToBot(r) : null;
    },

    async listBots(kind: ChannelKind, orgId: string): Promise<ChannelBot[]> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_bot WHERE kind = ? AND org_id = ? ORDER BY created_at`,
        args: [kind, orgId],
      });
      return res.rows.map((r) => rowToBot(r as Record<string, unknown>));
    },

    /** The org's ACTIVE bots of one kind bound to an agent (delivery-target pickers). */
    async botsForAgent(kind: ChannelKind, orgId: string, agent: string): Promise<ChannelBot[]> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_bot
              WHERE kind = ? AND org_id = ? AND agent = ? AND status = 'active'
              ORDER BY created_at`,
        args: [kind, orgId, agent],
      });
      return res.rows.map((r) => rowToBot(r as Record<string, unknown>));
    },

    /**
     * Record the platform-side handle once credentials validated. `resetWebhook`
     * clears the registration mark — a Telegram token save rotates the webhook
     * secret, so the webhook must be registered again.
     */
    async setExternalHandle(
      kind: ChannelKind,
      id: string,
      externalHandle: string,
      opts: { resetWebhook?: boolean } = {},
    ): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_channel_bot
              SET external_handle = ?, updated_at = ?
                  ${opts.resetWebhook ? ", webhook_registered_at = NULL" : ""}
              WHERE kind = ? AND id = ?`,
        args: [externalHandle, Date.now(), kind, id],
      });
    },

    async markWebhookRegistered(kind: ChannelKind, id: string): Promise<void> {
      const now = Date.now();
      await client.execute({
        sql: `UPDATE latch_channel_bot SET webhook_registered_at = ?, updated_at = ? WHERE kind = ? AND id = ?`,
        args: [now, now, kind, id],
      });
    },

    async setBotStatus(kind: ChannelKind, id: string, status: "active" | "disabled"): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_channel_bot SET status = ?, updated_at = ? WHERE kind = ? AND id = ?`,
        args: [status, Date.now(), kind, id],
      });
    },

    /** Delete a bot and everything keyed by it: identities, held messages, per-chat state. */
    async removeBot(kind: ChannelKind, id: string): Promise<void> {
      // Per-chat state is keyed by chat id, which embeds the bot id
      // (`<kind>_<botId>_<userId>`). Matched with `substr` rather than LIKE: `_`
      // is a LIKE wildcard and these keys are full of underscores.
      const prefix = `${kind}_${id}_`;
      await client.batch(
        [
          { sql: `DELETE FROM latch_channel_bot WHERE kind = ? AND id = ?`, args: [kind, id] },
          { sql: `DELETE FROM latch_channel_identity WHERE kind = ? AND bot_ref = ?`, args: [kind, id] },
          { sql: `DELETE FROM latch_channel_pending WHERE kind = ? AND bot_ref = ?`, args: [kind, id] },
          { sql: `DELETE FROM latch_channel_thread WHERE substr(chat_key, 1, ?) = ?`, args: [prefix.length, prefix] },
          { sql: `DELETE FROM latch_channel_ask WHERE substr(chat_id, 1, ?) = ?`, args: [prefix.length, prefix] },
          { sql: `DELETE FROM latch_channel_turn WHERE substr(chat_id, 1, ?) = ?`, args: [prefix.length, prefix] },
        ],
        "write",
      );
    },

    // ── Identities ───────────────────────────────────────────────────────────

    /**
     * Link a platform-side user to a Latch user. With `onConflict: "refuse"` (the
     * default) an existing link to a DIFFERENT Latch user is refused — re-linking
     * must be deliberate; the same user re-linking just refreshes the label.
     * Atomic: insert-if-absent, then a user_id-fenced update — two accounts
     * opening the same link concurrently can never overwrite each other.
     * `"replace"` is last-wins, for flows where the caller has already proven
     * ownership of both sides (a Slack installer completing their own install).
     */
    async linkIdentity(
      input: {
        kind: ChannelKind;
        botRef: string;
        externalId: string;
        userId: string;
        orgId: string;
        label?: string;
      },
      opts: { onConflict?: "refuse" | "replace" } = {},
    ): Promise<"linked" | "conflict"> {
      const now = Date.now();
      if (opts.onConflict === "replace") {
        await client.execute({
          sql: `INSERT INTO latch_channel_identity
                  (kind, bot_ref, external_id, user_id, org_id, label, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, bot_ref, external_id) DO UPDATE SET
                  user_id = excluded.user_id, org_id = excluded.org_id,
                  label = COALESCE(excluded.label, latch_channel_identity.label)`,
          args: [input.kind, input.botRef, input.externalId, input.userId, input.orgId, input.label ?? null, now],
        });
        return "linked";
      }
      const inserted = await client.execute({
        sql: `INSERT INTO latch_channel_identity
                (kind, bot_ref, external_id, user_id, org_id, label, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(kind, bot_ref, external_id) DO NOTHING`,
        args: [input.kind, input.botRef, input.externalId, input.userId, input.orgId, input.label ?? null, now],
      });
      if (inserted.rowsAffected === 1) return "linked";
      const refreshed = await client.execute({
        sql: `UPDATE latch_channel_identity SET label = COALESCE(?, label), org_id = ?
              WHERE kind = ? AND bot_ref = ? AND external_id = ? AND user_id = ?`,
        args: [input.label ?? null, input.orgId, input.kind, input.botRef, input.externalId, input.userId],
      });
      return refreshed.rowsAffected === 1 ? "linked" : "conflict";
    },

    /** The Latch user behind a platform identity, or null if unlinked. */
    async resolveIdentity(
      kind: ChannelKind,
      botRef: string,
      externalId: string,
    ): Promise<{ userId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT user_id, org_id FROM latch_channel_identity
              WHERE kind = ? AND bot_ref = ? AND external_id = ? LIMIT 1`,
        args: [kind, botRef, externalId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? { userId: String(r.user_id), orgId: String(r.org_id) } : null;
    },

    /**
     * The reverse: which platform identity a Latch user linked on this bot /
     * workspace. Needed by anything that starts a conversation FROM our side (a
     * scheduled run pushing into a DM). One user CAN hold several rows after
     * linking a second account, so the oldest link wins — deterministically, or a
     * scheduled push could land in a different account from one fire to the next.
     */
    async identityForUser(
      kind: ChannelKind,
      botRef: string,
      userId: string,
    ): Promise<{ externalId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT external_id, org_id FROM latch_channel_identity
              WHERE kind = ? AND bot_ref = ? AND user_id = ?
              ORDER BY created_at, external_id LIMIT 1`,
        args: [kind, botRef, userId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? { externalId: String(r.external_id), orgId: String(r.org_id) } : null;
    },

    // ── Held messages (post-link replay) ─────────────────────────────────────

    /** Hold the message that triggered a link prompt; one per identity, newest wins. */
    async setPending(
      kind: ChannelKind,
      botRef: string,
      externalId: string,
      payload: unknown,
      ttlMs = PENDING_TTL_MS,
    ): Promise<void> {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_channel_pending
                (kind, bot_ref, external_id, payload, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(kind, bot_ref, external_id) DO UPDATE SET
                payload = excluded.payload, expires_at = excluded.expires_at,
                created_at = excluded.created_at`,
        args: [kind, botRef, externalId, JSON.stringify(payload), now + ttlMs, now],
      });
    },

    /**
     * Fetch and clear a held message — replay-once, atomically: one statement
     * consumes the row, so two concurrent link confirmations can't both replay
     * it. Expired or corrupt rows read as absent (and are gone either way).
     */
    async takePending<T>(kind: ChannelKind, botRef: string, externalId: string): Promise<T | null> {
      const res = await client.execute({
        sql: `DELETE FROM latch_channel_pending
              WHERE kind = ? AND bot_ref = ? AND external_id = ?
              RETURNING payload, expires_at`,
        args: [kind, botRef, externalId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r || Number(r.expires_at) < Date.now()) return null;
      try {
        return JSON.parse(String(r.payload)) as T;
      } catch {
        return null;
      }
    },

    // ── Admission ────────────────────────────────────────────────────────────

    claimOnce,

    /** Webhook dedupe: true if this delivery key was ALREADY handled (drop it). */
    async seen(kind: ChannelKind, key: string): Promise<boolean> {
      return !(await claimOnce(`${kind}:${key}`, DELIVERY_TTL_MS));
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

    /** Cron retention for the TTL'd tables. */
    async pruneExpired(): Promise<void> {
      const now = Date.now();
      await client.batch(
        [
          { sql: `DELETE FROM latch_channel_dedupe WHERE expires_at < ?`, args: [now] },
          { sql: `DELETE FROM latch_channel_pending WHERE expires_at < ?`, args: [now] },
          { sql: `DELETE FROM latch_channel_turn WHERE expires_at < ?`, args: [now] },
        ],
        "write",
      );
    },
  };
}

export type ChannelStore = ReturnType<typeof createChannelStore>;
