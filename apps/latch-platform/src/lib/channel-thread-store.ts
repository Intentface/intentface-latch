import type { Client } from "@libsql/client";

/**
 * `latch_channel_thread` — which conversation a one-thread-per-person surface is
 * currently writing to, shared by every channel (chat ids are channel-prefixed,
 * e.g. `telegram_<bot>_<user>`, so one table can't collide across surfaces).
 *
 * A Telegram DM has no notion of threads: without this, every message a person
 * ever sends lands in one chat that grows forever. `/new` bumps the epoch and the
 * channel derives `<base>_t<epoch>` from it — epoch 0 keeps the original id, so no
 * existing conversation moves.
 *
 * Its own table rather than a column on `latch_telegram_identity`: identity rows
 * are deleted on unlink, which would silently drag someone back to a thread they
 * had rotated away from. No TTL — a thread pointer stays valid forever.
 */

export async function migrateChannelThread(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_thread (
    chat_key TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
}

/** The `ChannelThreadStore` methods, mixed into each channel's store. */
export function createChannelThreadStore(client: Client) {
  return {
    async currentThread(chatKey: string): Promise<number> {
      const res = await client.execute({
        sql: `SELECT epoch FROM latch_channel_thread WHERE chat_key = ?`,
        args: [chatKey],
      });
      return Number(res.rows[0]?.epoch ?? 0);
    },

    /**
     * Move to a fresh thread and return its epoch. One statement, so two
     * concurrent `/new`s can't both read the same epoch and write the same
     * successor (which would land the "new" conversation on top of an old one).
     */
    async rotateThread(chatKey: string): Promise<number> {
      const now = Date.now();
      const res = await client.execute({
        sql: `INSERT INTO latch_channel_thread (chat_key, epoch, updated_at)
              VALUES (?, 1, ?)
              ON CONFLICT(chat_key) DO UPDATE SET
                epoch = latch_channel_thread.epoch + 1,
                updated_at = excluded.updated_at
              RETURNING epoch`,
        args: [chatKey, now],
      });
      return Number(res.rows[0]?.epoch ?? 1);
    },
  };
}
