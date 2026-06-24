/**
 * Slack *app-management* API (the C "one-button" flow) — distinct from the
 * bot-token Web API used to post messages. These calls use an org App
 * Configuration token (create the app) or the app's client creds (OAuth
 * install). Management tokens can only create/modify apps — never read or post
 * workspace data (see Slack docs) — and expire in 12h, so we rotate on demand.
 */

async function post(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const form = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form,
  });
  return (await res.json()) as Record<string, unknown>;
}

export interface CreatedApp {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  /** Slack-provided URL to send the installing user to (adds state ourselves). */
  oauthAuthorizeUrl: string;
}

/** Rotate an expired config token; returns the fresh token + refresh token. */
export async function rotateConfigToken(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string }> {
  const r = await post("tooling.tokens.rotate", { refresh_token: refreshToken });
  if (r.ok !== true) throw new Error(`slack:tooling.tokens.rotate: ${String(r.error)}`);
  return { token: String(r.token), refreshToken: String(r.refresh_token) };
}

/**
 * Create an app from a manifest with a config token. If the token is expired
 * and a refresh token is available, rotate once and retry — calling back with
 * the rotated pair so the caller can persist it.
 */
export async function createAppFromManifest(opts: {
  configToken: string;
  refreshToken?: string;
  manifest: Record<string, unknown>;
  onRotate?: (rotated: { token: string; refreshToken: string }) => Promise<void> | void;
}): Promise<CreatedApp> {
  const manifestStr = JSON.stringify(opts.manifest);
  let token = opts.configToken;

  let r = await post("apps.manifest.create", { token, manifest: manifestStr });
  if (r.ok !== true && r.error === "token_expired" && opts.refreshToken) {
    const rotated = await rotateConfigToken(opts.refreshToken);
    await opts.onRotate?.(rotated);
    token = rotated.token;
    r = await post("apps.manifest.create", { token, manifest: manifestStr });
  }
  if (r.ok !== true) throw new Error(`slack:apps.manifest.create: ${String(r.error)}`);

  const creds = r.credentials as Record<string, string> | undefined;
  return {
    appId: String(r.app_id),
    clientId: String(creds?.client_id ?? ""),
    clientSecret: String(creds?.client_secret ?? ""),
    signingSecret: String(creds?.signing_secret ?? ""),
    oauthAuthorizeUrl: String(r.oauth_authorize_url ?? ""),
  };
}

/** Exchange an OAuth install `code` for the workspace bot token. */
export async function oauthAccess(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{
  botToken: string;
  teamId?: string;
  appId?: string;
  botUserId?: string;
  authedUserId?: string;
}> {
  const r = await post("oauth.v2.access", {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  if (r.ok !== true) throw new Error(`slack:oauth.v2.access: ${String(r.error)}`);
  return {
    botToken: String(r.access_token ?? ""),
    teamId: (r.team as { id?: string } | undefined)?.id,
    appId: r.app_id ? String(r.app_id) : undefined,
    botUserId: r.bot_user_id ? String(r.bot_user_id) : undefined,
    authedUserId: (r.authed_user as { id?: string } | undefined)?.id,
  };
}
