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
    agent_scope TEXT,
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
  // Slack user → platform user link: who in Slack is allowed to drive agents.
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_slack_identity (
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, slack_user_id)
  )`);
  // A message held while an unlinked user links, replayed after they link.
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_slack_pending (
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    thread_root TEXT NOT NULL,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, slack_user_id)
  )`);
  // Idempotent add for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  try {
    await client.execute(`ALTER TABLE latch_slack_app ADD COLUMN agent_scope TEXT`);
  } catch {
    /* column already exists */
  }
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
  /**
   * The scope the bound agent record had at binding time — inbound turns pin
   * resolution to it (`org:`/`user:` prefixed names, see agent-store.ts) so a
   * same-named personal agent can never shadow an org binding (and vice versa).
   * Undefined = a code-registry agent (unambiguous by construction).
   */
  agentScope?: "org" | "user";
  orgId: string;
  userId?: string;
  botName?: string;
}

const APP_COLUMNS = `SELECT app_id, team_id, agent, agent_scope, org_id, user_id, bot_name
              FROM latch_slack_app`;

const rowToApp = (r: Record<string, unknown>): SlackApp => ({
  appId: String(r.app_id),
  teamId: r.team_id ? String(r.team_id) : undefined,
  agent: String(r.agent),
  agentScope: r.agent_scope === "org" || r.agent_scope === "user" ? r.agent_scope : undefined,
  orgId: String(r.org_id),
  userId: r.user_id ? String(r.user_id) : undefined,
  botName: r.bot_name ? String(r.bot_name) : undefined,
});

export function createSlackStore(client: Client) {
  return {
    /**
     * Bind (or rebind) a Slack app to an agent + owner. Returns false when the
     * `app_id` is already bound by ANOTHER org: the upsert is guarded on
     * `org_id`, so a caller cannot hijack a foreign binding by claiming its app
     * id (the id is visible to every member of the hosting Slack workspace, and
     * is echoed in every event payload). Rebinds within the owning org proceed.
     */
    async bind(app: SlackApp): Promise<boolean> {
      const now = Date.now();
      const res = await client.execute({
        sql: `INSERT INTO latch_slack_app
                (app_id, team_id, agent, agent_scope, org_id, user_id, bot_name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(app_id) DO UPDATE SET
                team_id = excluded.team_id, agent = excluded.agent,
                agent_scope = excluded.agent_scope,
                user_id = excluded.user_id,
                bot_name = excluded.bot_name, updated_at = excluded.updated_at
              WHERE latch_slack_app.org_id = excluded.org_id`,
        args: [
          app.appId,
          app.teamId ?? null,
          app.agent,
          app.agentScope ?? null,
          app.orgId,
          app.userId ?? null,
          app.botName ?? null,
          now,
          now,
        ],
      });
      return res.rowsAffected > 0;
    },

    /** Look up the agent + owner behind a Slack app id (inbound dispatch). */
    async resolve(appId: string): Promise<SlackApp | null> {
      const res = await client.execute({
        sql: `${APP_COLUMNS} WHERE app_id = ? LIMIT 1`,
        args: [appId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToApp(r) : null;
    },

    /** The Slack apps owned within an org (for the editor's status view). */
    async listForOrg(orgId: string): Promise<SlackApp[]> {
      const res = await client.execute({
        sql: `${APP_COLUMNS} WHERE org_id = ?`,
        args: [orgId],
      });
      return res.rows.map((r) => rowToApp(r as Record<string, unknown>));
    },

    /**
     * Unbind a Slack app. Scoped by org so one tenant can never delete
     * another's binding by app id (the caller must also pass the ownership
     * check in `server.ts` — this is the fail-closed backstop).
     */
    async unbind(appId: string, orgId: string): Promise<void> {
      await client.execute({
        sql: `DELETE FROM latch_slack_app WHERE app_id = ? AND org_id = ?`,
        args: [appId, orgId],
      });
    },

    /** Link a Slack user to a platform user (so they may drive agents). */
    async linkIdentity(input: {
      teamId: string;
      slackUserId: string;
      userId: string;
      orgId: string;
    }): Promise<void> {
      await client.execute({
        sql: `INSERT INTO latch_slack_identity
                (team_id, slack_user_id, user_id, org_id, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(team_id, slack_user_id) DO UPDATE SET
                user_id = excluded.user_id, org_id = excluded.org_id`,
        args: [input.teamId, input.slackUserId, input.userId, input.orgId, Date.now()],
      });
    },

    /** The platform user linked to a Slack identity, or null if unlinked. */
    async resolveIdentity(
      teamId: string,
      slackUserId: string,
    ): Promise<{ userId: string; orgId: string } | null> {
      const res = await client.execute({
        sql: `SELECT user_id, org_id FROM latch_slack_identity
              WHERE team_id = ? AND slack_user_id = ? LIMIT 1`,
        args: [teamId, slackUserId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? { userId: String(r.user_id), orgId: String(r.org_id) } : null;
    },

    /** Hold the message that triggered a link prompt, to replay after linking. */
    async setPending(input: {
      teamId: string;
      slackUserId: string;
      appId: string;
      channel: string;
      threadRoot: string;
      prompt: string;
    }): Promise<void> {
      await client.execute({
        sql: `INSERT INTO latch_slack_pending
                (team_id, slack_user_id, app_id, channel, thread_root, prompt, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(team_id, slack_user_id) DO UPDATE SET
                app_id = excluded.app_id, channel = excluded.channel,
                thread_root = excluded.thread_root, prompt = excluded.prompt,
                created_at = excluded.created_at`,
        args: [
          input.teamId,
          input.slackUserId,
          input.appId,
          input.channel,
          input.threadRoot,
          input.prompt,
          Date.now(),
        ],
      });
    },

    /** Fetch and clear a held message (replay-once). */
    async takePending(
      teamId: string,
      slackUserId: string,
    ): Promise<{ appId: string; channel: string; threadRoot: string; prompt: string } | null> {
      const res = await client.execute({
        sql: `SELECT app_id, channel, thread_root, prompt FROM latch_slack_pending
              WHERE team_id = ? AND slack_user_id = ? LIMIT 1`,
        args: [teamId, slackUserId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      await client.execute({
        sql: `DELETE FROM latch_slack_pending WHERE team_id = ? AND slack_user_id = ?`,
        args: [teamId, slackUserId],
      });
      return {
        appId: String(r.app_id),
        channel: String(r.channel),
        threadRoot: String(r.thread_root),
        prompt: String(r.prompt),
      };
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
