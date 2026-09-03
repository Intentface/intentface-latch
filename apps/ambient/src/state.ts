import type { Client } from "@libsql/client";

/**
 * The channel's STATE DOCUMENT — the agent's own notes, written by the agent
 * through `update_state`, read back verbatim at the start of every tick.
 *
 * Deliberately not the memory package: memory extracts facts after the fact,
 * asynchronously, by inference. Here the agent is the only writer, the write
 * happens inside the turn, and what it wrote is exactly what it reads next
 * time. Two host tables next to Latch's own in the same SQLite file.
 */
export interface ChannelState {
  channel: string;
  /** Markdown, following the schema in the agent's instructions. Empty on first tick. */
  doc: string;
  /** Slack `ts` of the newest message the agent has read; null = never read. */
  cursor: string | null;
  updatedAt: number | null;
  /** Lines a human changed in the document since the agent last wrote it (canvas-backed store only). */
  humanEdits?: { added: string[]; removed: string[] };
}

/** Cap on the state document: past this `update_state` refuses and asks the agent to prune. */
export const MAX_DOC_CHARS = 12_000;

export type PostKind = "addressed" | "unprompted";

export interface StateStore {
  migrate(): Promise<void>;
  load(channel: string): Promise<ChannelState>;
  saveDoc(channel: string, doc: string): Promise<void>;
  /** Advance the read cursor; never moves it backwards. */
  advanceCursor(channel: string, ts: string): Promise<void>;
  recordPost(channel: string, ts: string, kind: PostKind): Promise<void>;
  /** Unprompted posts in the trailing window. */
  unpromptedPostsSince(channel: string, since: number): Promise<number>;
}

const tsNum = (ts: string | null): number => (ts ? Number(ts) : 0);

export function createStateStore(client: Client, now: () => number = Date.now): StateStore {
  return {
    async migrate() {
      await client.batch(
        [
          `CREATE TABLE IF NOT EXISTS ambient_channel_state (
             channel TEXT PRIMARY KEY,
             doc TEXT NOT NULL DEFAULT '',
             cursor TEXT,
             updated_at INTEGER
           )`,
          `CREATE TABLE IF NOT EXISTS ambient_posts (
             channel TEXT NOT NULL,
             ts TEXT NOT NULL,
             kind TEXT NOT NULL,
             posted_at INTEGER NOT NULL,
             PRIMARY KEY (channel, ts)
           )`,
          `CREATE INDEX IF NOT EXISTS ambient_posts_channel_at ON ambient_posts (channel, posted_at)`,
        ],
        "write",
      );
    },

    async load(channel) {
      const r = await client.execute({
        sql: `SELECT doc, cursor, updated_at FROM ambient_channel_state WHERE channel = ?`,
        args: [channel],
      });
      const row = r.rows[0];
      if (!row) return { channel, doc: "", cursor: null, updatedAt: null };
      return {
        channel,
        doc: String(row.doc ?? ""),
        cursor: row.cursor == null ? null : String(row.cursor),
        updatedAt: row.updated_at == null ? null : Number(row.updated_at),
      };
    },

    async saveDoc(channel, doc) {
      await client.execute({
        sql: `INSERT INTO ambient_channel_state (channel, doc, updated_at) VALUES (?, ?, ?)
              ON CONFLICT (channel) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
        args: [channel, doc, now()],
      });
    },

    async advanceCursor(channel, ts) {
      const current = await this.load(channel);
      if (tsNum(ts) <= tsNum(current.cursor)) return;
      await client.execute({
        sql: `INSERT INTO ambient_channel_state (channel, cursor) VALUES (?, ?)
              ON CONFLICT (channel) DO UPDATE SET cursor = excluded.cursor`,
        args: [channel, ts],
      });
    },

    async recordPost(channel, ts, kind) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO ambient_posts (channel, ts, kind, posted_at) VALUES (?, ?, ?, ?)`,
        args: [channel, ts, kind, now()],
      });
    },

    async unpromptedPostsSince(channel, since) {
      const r = await client.execute({
        sql: `SELECT count(*) AS n FROM ambient_posts WHERE channel = ? AND kind = 'unprompted' AND posted_at >= ?`,
        args: [channel, since],
      });
      return Number(r.rows[0]?.n ?? 0);
    },
  };
}
