import type { Client } from "@libsql/client";

/**
 * Slack-only persistence (own-app-per-agent):
 *  - `latch_slack_app`    — one row per agent's dedicated Slack app: the Slack
 *    `api_app_id` → the agent + its owner, plus a dozen Slack-specific columns
 *    (credential mode, bot user id, manifest version, health). The bot token +
 *    signing secret live in the Vault (keyed by app id), not here.
 *  - `latch_slack_thread` — initiator-owned thread registry + the stop flag.
 *
 * Identities, held replays, dedupe claims and turn leases live in the shared
 * channel store (`channel-store.ts`), like every other channel's.
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
  // Thread ownership (initiator-owned chats) + the cross-instance stop flag.
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_slack_thread (
    chat_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    initiator_slack_user_id TEXT NOT NULL,
    initiator_user_id TEXT,
    stopped_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_slack_app_org_agent ON latch_slack_app(org_id, agent)`,
  );

  // Idempotent adds for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  for (const col of [
    "agent_scope TEXT",
    "credential_mode TEXT",
    "bot_user_id TEXT",
    "status TEXT", // NULL reads as 'active'; 'disabled' after uninstall/revoke
    "disabled_reason TEXT",
    "manifest_version INTEGER", // NULL/1 = pre-agent_view manifest; 2 = migrated
    "unattended_channels TEXT", // JSON array: post_to_channel allowlist
    "last_event_at INTEGER", // bot health: last verified webhook event
    "last_stream_error TEXT", // why the streaming renderer degraded, if it did
  ]) {
    try {
      await client.execute(`ALTER TABLE latch_slack_app ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
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
  /**
   * Whose credentials turns run with. `'per-user'` (the default, and what a
   * NULL column reads as): each member acts with their own grants — a member
   * without one gets their own sign-in card. `'shared'`: every member acts
   * through the BINDING CREATOR's grants — an explicit, consented choice made
   * at bind time ("power this bot with my integrations"), never a silent
   * default, because it means anyone in the channel reads through that
   * person's access.
   */
  credentialMode?: "per-user" | "shared";
  /**
   * The bot's own Slack user id, captured at install (`oauth.v2.access` →
   * `bot_user_id`). The AUTHORITATIVE self-check: `bot_id`/`subtype` are absent
   * on some post shapes, and a bot message that isn't recognized as one passes
   * the thread-following gate — the bot answers its own message, posts again,
   * and the thread runs away (observed: 22 runs and 44 events from ~3 real
   * exchanges). Comparing `event.user` to this id can't miss. The v2 channel
   * REQUIRES it — a binding without one must be reinstalled.
   */
  botUserId?: string;
  /** 'disabled' after tokens_revoked/app_uninstalled; NULL reads as 'active'. */
  status?: "active" | "disabled";
  disabledReason?: string;
  /** NULL/1 = pre-agent_view manifest; 2 = migrated to the v2 manifest. */
  manifestVersion?: number;
  /** Channel ids where post_to_channel runs WITHOUT approval (digests). */
  unattendedChannels?: string[];
  /** Last verified webhook event (bot health). */
  lastEventAt?: number;
  /** Slack's refusal (code + detail) the last time streaming degraded. */
  lastStreamError?: string;
}

/** A Slack-anchored chat's ownership row. */
export interface SlackThread {
  chatId: string;
  appId: string;
  initiatorSlackUserId: string;
  initiatorUserId?: string;
  stoppedAt?: number;
  createdAt: number;
}

const APP_COLUMNS = `SELECT app_id, team_id, agent, agent_scope, org_id, user_id, bot_name, credential_mode, bot_user_id,
                     status, disabled_reason, manifest_version, unattended_channels, last_event_at, last_stream_error
              FROM latch_slack_app`;

const rowToApp = (r: Record<string, unknown>): SlackApp => {
  let unattended: string[] | undefined;
  try {
    unattended = r.unattended_channels
      ? (JSON.parse(String(r.unattended_channels)) as string[])
      : undefined;
  } catch {
    unattended = undefined; // corrupt allowlist fails CLOSED (everything gated)
  }
  return {
    appId: String(r.app_id),
    teamId: r.team_id ? String(r.team_id) : undefined,
    agent: String(r.agent),
    agentScope: r.agent_scope === "org" || r.agent_scope === "user" ? r.agent_scope : undefined,
    orgId: String(r.org_id),
    userId: r.user_id ? String(r.user_id) : undefined,
    botName: r.bot_name ? String(r.bot_name) : undefined,
    credentialMode: r.credential_mode === "shared" ? "shared" : "per-user",
    botUserId: r.bot_user_id ? String(r.bot_user_id) : undefined,
    status: r.status === "disabled" ? "disabled" : "active",
    disabledReason: r.disabled_reason ? String(r.disabled_reason) : undefined,
    manifestVersion: r.manifest_version ? Number(r.manifest_version) : undefined,
    unattendedChannels: unattended,
    lastEventAt: r.last_event_at ? Number(r.last_event_at) : undefined,
    lastStreamError: r.last_stream_error ? String(r.last_stream_error) : undefined,
  };
};

export function createSlackStore(client: Client) {
  async function getThread(chatId: string): Promise<SlackThread | null> {
    const res = await client.execute({
      sql: `SELECT chat_id, app_id, initiator_slack_user_id, initiator_user_id, stopped_at, created_at
            FROM latch_slack_thread WHERE chat_id = ? LIMIT 1`,
      args: [chatId],
    });
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      chatId: String(r.chat_id),
      appId: String(r.app_id),
      initiatorSlackUserId: String(r.initiator_slack_user_id),
      initiatorUserId: r.initiator_user_id ? String(r.initiator_user_id) : undefined,
      stoppedAt: r.stopped_at ? Number(r.stopped_at) : undefined,
      createdAt: Number(r.created_at),
    };
  }

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
                (app_id, team_id, agent, agent_scope, org_id, user_id, bot_name, credential_mode, bot_user_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(app_id) DO UPDATE SET
                team_id = excluded.team_id, agent = excluded.agent,
                agent_scope = excluded.agent_scope,
                user_id = excluded.user_id,
                bot_name = excluded.bot_name,
                credential_mode = excluded.credential_mode,
                -- Re-binds that don't re-run OAuth carry no bot user id; keep
                -- the stored one rather than nulling the loop guard.
                bot_user_id = COALESCE(excluded.bot_user_id, latch_slack_app.bot_user_id),
                updated_at = excluded.updated_at
              WHERE latch_slack_app.org_id = excluded.org_id`,
        args: [
          app.appId,
          app.teamId ?? null,
          app.agent,
          app.agentScope ?? null,
          app.orgId,
          app.userId ?? null,
          app.botName ?? null,
          app.credentialMode ?? "per-user",
          app.botUserId ?? null,
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

    /** The org's Slack apps bound to one agent (for delivery-target pickers). */
    async appsForAgent(orgId: string, agent: string): Promise<SlackApp[]> {
      const res = await client.execute({
        sql: `${APP_COLUMNS} WHERE org_id = ? AND agent = ?`,
        args: [orgId, agent],
      });
      return res.rows.map((r) => rowToApp(r as Record<string, unknown>));
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

    // ── Thread ownership + stop flag ──────────────────────────────────────────

    /** Atomic first-writer-wins; returns the OWNING row either way. */
    async claimThread(input: {
      chatId: string;
      appId: string;
      initiatorSlackUserId: string;
      initiatorUserId?: string;
    }): Promise<SlackThread> {
      await client.execute({
        sql: `INSERT INTO latch_slack_thread
                (chat_id, app_id, initiator_slack_user_id, initiator_user_id, created_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(chat_id) DO NOTHING`,
        args: [
          input.chatId,
          input.appId,
          input.initiatorSlackUserId,
          input.initiatorUserId ?? null,
          Date.now(),
        ],
      });
      const row = await getThread(input.chatId);
      if (!row) throw new Error(`slack thread claim failed for ${input.chatId}`);
      return row;
    },

    getThread,

    async markThreadStopped(chatId: string): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_thread SET stopped_at = ? WHERE chat_id = ?`,
        args: [Date.now(), chatId],
      });
    },

    async threadStoppedSince(chatId: string, sinceMs: number): Promise<boolean> {
      const res = await client.execute({
        sql: `SELECT 1 FROM latch_slack_thread WHERE chat_id = ? AND stopped_at > ? LIMIT 1`,
        args: [chatId, sinceMs],
      });
      return res.rows.length > 0;
    },

    // ── Binding lifecycle & health ────────────────────────────────────────────

    /** Disable/enable a binding (uninstall, token revocation, manual). */
    async setStatus(
      appId: string,
      status: "active" | "disabled",
      reason?: string,
    ): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_app SET status = ?, disabled_reason = ?, updated_at = ?
              WHERE app_id = ?`,
        args: [status === "active" ? null : status, reason ?? null, Date.now(), appId],
      });
    },

    /** Every binding in a workspace (lifecycle events carry only team_id). */
    async appsForTeam(teamId: string): Promise<SlackApp[]> {
      const res = await client.execute({
        sql: `${APP_COLUMNS} WHERE team_id = ?`,
        args: [teamId],
      });
      return res.rows.map((r) => rowToApp(r as Record<string, unknown>));
    },

    async setManifestVersion(appId: string, orgId: string, version: number): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_app SET manifest_version = ?, updated_at = ?
              WHERE app_id = ? AND org_id = ?`,
        args: [version, Date.now(), appId, orgId],
      });
    },

    async setUnattendedChannels(appId: string, orgId: string, channels: string[]): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_app SET unattended_channels = ?, updated_at = ?
              WHERE app_id = ? AND org_id = ?`,
        args: [JSON.stringify(channels), Date.now(), appId, orgId],
      });
    },

    /** Streaming health: null = native streaming worked on the last turn. */
    async setStreamError(appId: string, error: string | null): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_app SET last_stream_error = ? WHERE app_id = ?`,
        args: [error, appId],
      });
    },

    /** Bot health: a verified webhook event arrived for this app. */
    async touchEvent(appId: string): Promise<void> {
      await client.execute({
        sql: `UPDATE latch_slack_app SET last_event_at = ? WHERE app_id = ?`,
        args: [Date.now(), appId],
      });
    },

  };
}

export type SlackStore = ReturnType<typeof createSlackStore>;
