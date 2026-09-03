import type { Client } from "@libsql/client";

/**
 * Host-side state next to Latch's tables, in the same SQLite file:
 *
 *   • the channel's STATE DOCUMENT — the agent's notes, written by the agent
 *     through `update_state`, read back verbatim at the start of every tick
 *     (deliberately not the memory package: the agent is the only writer, the
 *     write happens inside the turn, and it reads exactly what it wrote);
 *   • the INBOX — every Slack event for the channel, waiting for the next tick;
 *   • the POST LOG — for the unprompted-post budget.
 */
export interface ChannelState {
  channel: string;
  /** Markdown, following the schema in the agent's instructions. Empty on first tick. */
  doc: string;
  /** When the agent first read the channel's recent history; null = never. */
  bootstrappedAt: number | null;
  updatedAt: number | null;
  /** Lines a human changed in the document since the agent last wrote it (canvas-backed store only). */
  humanEdits?: { added: string[]; removed: string[] };
}

/** Cap on the state document: past this `update_state` refuses and asks the agent to prune. */
export const MAX_DOC_CHARS = 12_000;

export type PostKind = "addressed" | "unprompted";

/** One normalized Slack event, as the agent sees it. */
export type Observation =
  | { kind: "message" | "reply" | "mention"; ts: string; threadTs?: string; userId?: string; text: string; files?: number }
  | { kind: "edit"; ts: string; threadTs?: string; userId?: string; text: string; targetTs: string }
  | { kind: "delete"; ts: string; threadTs?: string; targetTs: string }
  | { kind: "reaction_added" | "reaction_removed"; ts: string; userId?: string; emoji: string; targetTs: string };

export interface StateStore {
  migrate(): Promise<void>;
  load(channel: string): Promise<ChannelState>;
  saveDoc(channel: string, doc: string): Promise<void>;
  markBootstrapped(channel: string): Promise<void>;
  recordPost(channel: string, ts: string, kind: PostKind): Promise<void>;
  /** Unprompted posts in the trailing window. */
  unpromptedPostsSince(channel: string, since: number): Promise<number>;
  /** Queue an observation (idempotent on `key`, e.g. Slack's event_id). */
  push(channel: string, key: string, obs: Observation): Promise<void>;
  /** Drain the inbox, oldest first. */
  drain(channel: string): Promise<Observation[]>;
  /** Look without draining: the queued observations and the age of the oldest. */
  peek(channel: string): Promise<{ events: Observation[]; oldestReceivedAt: number | null }>;
  pending(channel: string): Promise<number>;
  /** Every triage verdict, for "why did it (not) react". */
  logTriage(channel: string, v: TriageRow): Promise<void>;
  listTriage(channel: string, limit?: number): Promise<(TriageRow & { at: number })[]>;
}

export interface TriageRow {
  act: boolean;
  stage: "rule" | "model";
  reason: string;
  events: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function createStateStore(client: Client, now: () => number = Date.now): StateStore {
  return {
    async migrate() {
      await client.batch(
        [
          `CREATE TABLE IF NOT EXISTS ambient_channel_state (
             channel TEXT PRIMARY KEY,
             doc TEXT NOT NULL DEFAULT '',
             bootstrapped_at INTEGER,
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
          `CREATE TABLE IF NOT EXISTS ambient_triage (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             channel TEXT NOT NULL,
             at INTEGER NOT NULL,
             act INTEGER NOT NULL,
             stage TEXT NOT NULL,
             reason TEXT NOT NULL,
             events INTEGER NOT NULL,
             input_tokens INTEGER,
             output_tokens INTEGER
           )`,
          `CREATE INDEX IF NOT EXISTS ambient_triage_channel_at ON ambient_triage (channel, at DESC)`,
          `CREATE TABLE IF NOT EXISTS ambient_inbox (
             channel TEXT NOT NULL,
             key TEXT NOT NULL,
             ts TEXT NOT NULL,
             payload TEXT NOT NULL,
             received_at INTEGER NOT NULL,
             PRIMARY KEY (channel, key)
           )`,
        ],
        "write",
      );
    },

    async load(channel) {
      const r = await client.execute({
        sql: `SELECT doc, bootstrapped_at, updated_at FROM ambient_channel_state WHERE channel = ?`,
        args: [channel],
      });
      const row = r.rows[0];
      if (!row) return { channel, doc: "", bootstrappedAt: null, updatedAt: null };
      return {
        channel,
        doc: String(row.doc ?? ""),
        bootstrappedAt: row.bootstrapped_at == null ? null : Number(row.bootstrapped_at),
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

    async markBootstrapped(channel) {
      await client.execute({
        sql: `INSERT INTO ambient_channel_state (channel, bootstrapped_at) VALUES (?, ?)
              ON CONFLICT (channel) DO UPDATE SET bootstrapped_at = coalesce(ambient_channel_state.bootstrapped_at, excluded.bootstrapped_at)`,
        args: [channel, now()],
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

    async push(channel, key, obs) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO ambient_inbox (channel, key, ts, payload, received_at) VALUES (?, ?, ?, ?, ?)`,
        args: [channel, key, obs.ts, JSON.stringify(obs), now()],
      });
    },

    async drain(channel) {
      const r = await client.execute({
        sql: `DELETE FROM ambient_inbox WHERE channel = ? RETURNING ts, payload`,
        args: [channel],
      });
      return r.rows
        .map((row) => JSON.parse(String(row.payload)) as Observation)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
    },

    async peek(channel) {
      const r = await client.execute({ sql: `SELECT ts, payload, received_at FROM ambient_inbox WHERE channel = ?`, args: [channel] });
      const events = r.rows.map((row) => JSON.parse(String(row.payload)) as Observation).sort((a, b) => Number(a.ts) - Number(b.ts));
      const oldest = r.rows.reduce<number | null>((m, row) => (m === null ? Number(row.received_at) : Math.min(m, Number(row.received_at))), null);
      return { events, oldestReceivedAt: oldest };
    },

    async logTriage(channel, v) {
      await client.execute({
        sql: `INSERT INTO ambient_triage (channel, at, act, stage, reason, events, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [channel, now(), v.act ? 1 : 0, v.stage, v.reason, v.events, v.inputTokens ?? null, v.outputTokens ?? null],
      });
    },

    async listTriage(channel, limit = 50) {
      const r = await client.execute({
        sql: `SELECT at, act, stage, reason, events, input_tokens, output_tokens FROM ambient_triage WHERE channel = ? ORDER BY at DESC, id DESC LIMIT ?`,
        args: [channel, limit],
      });
      return r.rows.map((row) => ({
        at: Number(row.at),
        act: Number(row.act) === 1,
        stage: String(row.stage) as "rule" | "model",
        reason: String(row.reason),
        events: Number(row.events),
        ...(row.input_tokens == null ? {} : { inputTokens: Number(row.input_tokens) }),
        ...(row.output_tokens == null ? {} : { outputTokens: Number(row.output_tokens) }),
      }));
    },

    async pending(channel) {
      const r = await client.execute({ sql: `SELECT count(*) AS n FROM ambient_inbox WHERE channel = ?`, args: [channel] });
      return Number(r.rows[0]?.n ?? 0);
    },
  };
}
