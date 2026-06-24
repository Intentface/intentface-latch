import type { Client } from "@libsql/client";

/**
 * Persistence for the Slack channel (own-app-per-agent):
 *  - `latch_slack_app`  — one row per agent's dedicated Slack app: maps the
 *    Slack `api_app_id` → the agent + its owner (the Principal we run as). The
 *    bot token + signing secret live in the Vault (keyed by app id), not here.
 *  - `latch_slack_event` — seen Slack `event_id`s, for cross-invocation dedupe
 *    (Slack re-delivers events; an in-process Set is not enough on serverless).
 *
 * Idempotent create-if-not-exists, same pattern as `migrateAgents`.
 */
export async function migrateSlack(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_slack_app (
    app_id TEXT PRIMARY KEY,
    team_id TEXT,
    agent TEXT NOT NULL,
    org_id TEXT NOT NULL,
    user_id TEXT,
    bot_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_slack_event (
    event_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`);
}

/** Vault credential key names for a Slack app's secrets (stored at org scope). */
export const slackVaultKeys = (appId: string) => ({
  botToken: `slack_bot_token:${appId}`,
  signingSecret: `slack_signing_secret:${appId}`,
  clientId: `slack_client_id:${appId}`,
  clientSecret: `slack_client_secret:${appId}`,
});

/** Org-scoped Slack App-Configuration token (one-button create) + its refresh. */
export const SLACK_CONFIG_TOKEN_KEY = "slack_config_token";
export const SLACK_CONFIG_REFRESH_KEY = "slack_config_refresh";

export interface SlackApp {
  appId: string;
  teamId?: string;
  agent: string;
  orgId: string;
  userId?: string;
  botName?: string;
}

export function createSlackStore(client: Client) {
  return {
    /** Bind (or rebind) a Slack app to an agent + owner. */
    async bind(app: SlackApp): Promise<void> {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_slack_app
                (app_id, team_id, agent, org_id, user_id, bot_name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(app_id) DO UPDATE SET
                team_id = excluded.team_id, agent = excluded.agent,
                org_id = excluded.org_id, user_id = excluded.user_id,
                bot_name = excluded.bot_name, updated_at = excluded.updated_at`,
        args: [
          app.appId,
          app.teamId ?? null,
          app.agent,
          app.orgId,
          app.userId ?? null,
          app.botName ?? null,
          now,
          now,
        ],
      });
    },

    /** Look up the agent + owner behind a Slack app id (inbound dispatch). */
    async resolve(appId: string): Promise<SlackApp | null> {
      const res = await client.execute({
        sql: `SELECT app_id, team_id, agent, org_id, user_id, bot_name
              FROM latch_slack_app WHERE app_id = ? LIMIT 1`,
        args: [appId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        appId: String(r.app_id),
        teamId: r.team_id ? String(r.team_id) : undefined,
        agent: String(r.agent),
        orgId: String(r.org_id),
        userId: r.user_id ? String(r.user_id) : undefined,
        botName: r.bot_name ? String(r.bot_name) : undefined,
      };
    },

    /** The Slack apps owned within an org (for the editor's status view). */
    async listForOrg(orgId: string): Promise<SlackApp[]> {
      const res = await client.execute({
        sql: `SELECT app_id, team_id, agent, org_id, user_id, bot_name
              FROM latch_slack_app WHERE org_id = ?`,
        args: [orgId],
      });
      return res.rows.map((r) => ({
        appId: String(r.app_id),
        teamId: r.team_id ? String(r.team_id) : undefined,
        agent: String(r.agent),
        orgId: String(r.org_id),
        userId: r.user_id ? String(r.user_id) : undefined,
        botName: r.bot_name ? String(r.bot_name) : undefined,
      }));
    },

    async unbind(appId: string): Promise<void> {
      await client.execute({ sql: `DELETE FROM latch_slack_app WHERE app_id = ?`, args: [appId] });
    },

    /**
     * Mark a Slack event id as handled; returns true if it was ALREADY seen
     * (so the caller should drop it). Relies on the PK conflict — a fresh insert
     * affects 1 row, a duplicate affects 0.
     */
    async seen(eventId: string): Promise<boolean> {
      const res = await client.execute({
        sql: `INSERT INTO latch_slack_event (event_id, created_at) VALUES (?, ?)
              ON CONFLICT(event_id) DO NOTHING`,
        args: [eventId, Date.now()],
      });
      return res.rowsAffected === 0;
    },
  };
}

export type SlackStore = ReturnType<typeof createSlackStore>;
