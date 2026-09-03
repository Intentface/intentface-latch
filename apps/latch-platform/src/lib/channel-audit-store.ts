/**
 * Channel audit log — one row per admission decision a channel adapter makes
 * (did we act on this message / click, and why not) and per tool call inside a
 * channel-triggered turn (from the channel's scope guard).
 *
 * TTL'd, not grow-forever: `latch_slack_event` taught us that an unbounded
 * per-event table is the wrong shape on a hosted row budget. Every write
 * carries `expires_at` and sweeps what has expired — retention needs no job.
 * Queried by SQL until a UI earns its place.
 */
import type { Client } from "@libsql/client";

export type ChannelAuditDecision = "allow" | "deny";

export interface ChannelAuditRecord {
  /** Channel kind (`slack` for now). */
  channel: string;
  /** trigger | resume | approval_click | tool_call — open vocabulary per channel. */
  action: string;
  decision: ChannelAuditDecision;
  /** Machine-readable reason on deny (e.g. `external_workspace`, `off_channel`). */
  reason?: string;
  orgId?: string;
  agent?: string;
  /** Channel app/bot binding id (Slack `api_app_id`). */
  appId?: string;
  teamId?: string;
  externalChannelId?: string;
  threadRoot?: string;
  /** The channel-side user (Slack user id). */
  externalUserId?: string;
  /** The Latch user, when the identity is linked. */
  userId?: string;
  chatId?: string;
  runId?: string;
  /** Small JSON extras (tool name, offending channel, …). */
  meta?: Record<string, unknown>;
}

export interface ChannelAuditRow extends ChannelAuditRecord {
  id: number;
  ts: number;
  expiresAt: number;
}

export const CHANNEL_AUDIT_TTL_MS = 90 * 24 * 3600_000;

export async function migrateChannelAudit(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    action TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    org_id TEXT,
    agent TEXT,
    app_id TEXT,
    team_id TEXT,
    external_channel_id TEXT,
    thread_root TEXT,
    external_user_id TEXT,
    user_id TEXT,
    chat_id TEXT,
    run_id TEXT,
    meta TEXT
  )`);
  // libsql runs one statement per execute — indexes are their own calls.
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_channel_audit_app_ts ON latch_channel_audit(app_id, ts)`,
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_channel_audit_expires ON latch_channel_audit(expires_at)`,
  );
}

export function createChannelAuditStore(
  client: Client,
  opts: { now?: () => number; ttlMs?: number } = {},
) {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? CHANNEL_AUDIT_TTL_MS;

  return {
    /** Append one decision. Sweeps expired rows on the way (cheap, indexed). */
    async record(e: ChannelAuditRecord): Promise<void> {
      const ts = now();
      await client.execute({
        sql: `INSERT INTO latch_channel_audit
                (ts, expires_at, channel, action, decision, reason, org_id, agent, app_id, team_id,
                 external_channel_id, thread_root, external_user_id, user_id, chat_id, run_id, meta)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          ts,
          ts + ttl,
          e.channel,
          e.action,
          e.decision,
          e.reason ?? null,
          e.orgId ?? null,
          e.agent ?? null,
          e.appId ?? null,
          e.teamId ?? null,
          e.externalChannelId ?? null,
          e.threadRoot ?? null,
          e.externalUserId ?? null,
          e.userId ?? null,
          e.chatId ?? null,
          e.runId ?? null,
          e.meta ? JSON.stringify(e.meta) : null,
        ],
      });
      await client
        .execute({ sql: `DELETE FROM latch_channel_audit WHERE expires_at < ?`, args: [ts] })
        .catch(() => {
          /* the sweep is opportunistic */
        });
    },

    /** Newest first — for debugging "why didn't it answer" and for tests. */
    async list(filter: { appId?: string; chatId?: string; limit?: number } = {}): Promise<
      ChannelAuditRow[]
    > {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (filter.appId) {
        where.push("app_id = ?");
        args.push(filter.appId);
      }
      if (filter.chatId) {
        where.push("chat_id = ?");
        args.push(filter.chatId);
      }
      args.push(filter.limit ?? 100);
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY ts DESC, id DESC LIMIT ?`,
        args,
      });
      return res.rows.map((raw) => {
        const r = raw as Record<string, unknown>;
        const str = (k: string) => (r[k] == null ? undefined : String(r[k]));
        const row: ChannelAuditRow = {
          id: Number(r.id),
          ts: Number(r.ts),
          expiresAt: Number(r.expires_at),
          channel: String(r.channel),
          action: String(r.action),
          decision: String(r.decision) as ChannelAuditDecision,
        };
        const optional: [keyof ChannelAuditRecord, string][] = [
          ["reason", "reason"],
          ["orgId", "org_id"],
          ["agent", "agent"],
          ["appId", "app_id"],
          ["teamId", "team_id"],
          ["externalChannelId", "external_channel_id"],
          ["threadRoot", "thread_root"],
          ["externalUserId", "external_user_id"],
          ["userId", "user_id"],
          ["chatId", "chat_id"],
          ["runId", "run_id"],
        ];
        for (const [key, col] of optional) {
          const v = str(col);
          if (v !== undefined) (row as unknown as Record<string, unknown>)[key] = v;
        }
        if (r.meta) {
          try {
            row.meta = JSON.parse(String(r.meta)) as Record<string, unknown>;
          } catch {
            /* corrupt meta is not worth failing a read */
          }
        }
        return row;
      });
    },
  };
}

export type ChannelAuditStore = ReturnType<typeof createChannelAuditStore>;
