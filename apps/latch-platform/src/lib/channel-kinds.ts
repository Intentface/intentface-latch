import { randomBytes } from "node:crypto";
import { telegramCommandMenu } from "@intentface/latch-channels";
import { telegramApi } from "@intentface/latch-channels/telegram";
import { whatsappApi } from "@intentface/latch-channels/whatsapp";
import { telegramVaultKeys, whatsappVaultKeys } from "./channel-store";
import type { Principal } from "./session";

/**
 * What differs between DM channels when an operator onboards a bot — and
 * nothing else. The generic bot server functions (`server.ts`) and the editor's
 * `ChannelSection` are written once against this table; a new DM platform adds
 * an entry here (and a UI descriptor in `channel-kinds-ui.ts`), not another set
 * of server functions and another hand-written section.
 *
 * Slack is deliberately not here: its onboarding is manifest + OAuth install
 * with per-user/shared credential modes, a different shape altogether.
 */

export type DmChannelKind = "telegram" | "whatsapp";

/** The slice of the Vault-backed credentials store the registry needs. */
export interface CredentialOps {
  get: (p: Principal, key: string, scope: "org") => Promise<string | undefined | null>;
  set: (p: Principal, key: string, scope: "org", value: string) => Promise<void>;
  has: (p: Principal, key: string, scope: "org") => Promise<boolean>;
  remove: (p: Principal, key: string, scope: "org") => Promise<void>;
}

export interface KindCtx {
  principal: Principal;
  credentials: CredentialOps;
  botId: string;
  /** Absolute URL of the bot's webhook route. */
  eventsUrl: string;
}

/** One line of a webhook panel: a copyable value, a status, or an error. */
export interface WebhookField {
  label: string;
  value: string;
  copy?: boolean;
  error?: boolean;
}

export interface ChannelKindDef {
  /** Vault keys holding this bot's secrets (all removed with the bot). */
  vaultKeys: (botId: string) => Record<string, string>;
  /** Path of the per-bot webhook route. */
  eventsPath: (botId: string) => string;
  /**
   * Validate pasted credentials against the platform. Returns the platform-side
   * handle to record on the bot row; throws with a user-facing message.
   */
  validate: (creds: Record<string, string>) => Promise<{ externalHandle: string }>;
  /** Persist validated credentials (and any server-generated secrets) into the Vault. */
  saveCredentials: (ctx: KindCtx, creds: Record<string, string>) => Promise<void>;
  /**
   * `register`: we call the platform to point its webhook at us (a button).
   * `manual`: the operator pastes our URL + token into the platform's dashboard.
   */
  webhook: "register" | "manual";
  registerWebhook?: (ctx: KindCtx) => Promise<void>;
  /** What the webhook panel shows: platform status for `register`, dashboard values for `manual`. */
  webhookInfo: (ctx: KindCtx) => Promise<WebhookField[] | null>;
  /** Best-effort platform-side cleanup before the binding is deleted. */
  beforeDelete?: (ctx: KindCtx) => Promise<void>;
}

const required = (creds: Record<string, string>, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = (creds[k] ?? "").trim();
    if (!v) throw new Error("all credentials are required");
    out[k] = v;
  }
  return out;
};

export const CHANNEL_KINDS: Record<DmChannelKind, ChannelKindDef> = {
  telegram: {
    vaultKeys: telegramVaultKeys,
    eventsPath: (botId) => `/api/telegram/${botId}/events`,
    validate: async (creds) => {
      const { botToken } = required(creds, ["botToken"]);
      const me = await telegramApi(botToken).getMe();
      return { externalHandle: me.username };
    },
    /**
     * A token save always requires a webhook re-register: the webhook secret is
     * rotated with it. "Replace token": the OLD bot account may still have its
     * webhook pointed at this endpoint — once its token is overwritten it can
     * never be cleaned up (it would just collect 401s), so remove it first.
     */
    saveCredentials: async ({ principal, credentials, botId }, creds) => {
      const { botToken } = required(creds, ["botToken"]);
      const keys = telegramVaultKeys(botId);
      const oldToken = await credentials.get(principal, keys.botToken, "org");
      if (oldToken && oldToken !== botToken) {
        await telegramApi(oldToken).deleteWebhook().catch(() => {});
      }
      await credentials.set(principal, keys.botToken, "org", botToken);
      await credentials.set(principal, keys.webhookSecret, "org", randomBytes(24).toString("base64url"));
    },
    webhook: "register",
    registerWebhook: async ({ principal, credentials, botId, eventsUrl }) => {
      const keys = telegramVaultKeys(botId);
      const token = await credentials.get(principal, keys.botToken, "org");
      const secret = await credentials.get(principal, keys.webhookSecret, "org");
      if (!token || !secret) throw new Error("save the bot token first");
      const api = telegramApi(token);
      await api.setWebhook({ url: eventsUrl, secretToken: secret });
      // Publish the "/" menu too — the commands work regardless, but nothing else
      // makes them discoverable. Cosmetic, so a failure must not fail the hookup.
      await api
        .setMyCommands(telegramCommandMenu())
        .catch((e) => console.error("[telegram] setMyCommands failed:", e));
    },
    webhookInfo: async ({ principal, credentials, botId }) => {
      const token = await credentials.get(principal, telegramVaultKeys(botId).botToken, "org");
      if (!token) return null;
      const info = await telegramApi(token).getWebhookInfo();
      return [
        { label: "url", value: info.url || "(not set)" },
        { label: "pending updates", value: String(info.pendingUpdateCount) },
        ...(info.lastErrorMessage ? [{ label: "last error", value: info.lastErrorMessage, error: true }] : []),
      ];
    },
    beforeDelete: async ({ principal, credentials, botId }) => {
      const token = await credentials.get(principal, telegramVaultKeys(botId).botToken, "org");
      if (token) await telegramApi(token).deleteWebhook().catch(() => {});
    },
  },

  whatsapp: {
    vaultKeys: whatsappVaultKeys,
    eventsPath: (botId) => `/api/whatsapp/${botId}/events`,
    validate: async (creds) => {
      // The Graph API check only exercises the token + phone-number id; an
      // empty app secret would silently key webhook HMAC verification to "".
      const { accessToken, phoneNumberId } = required(creds, ["accessToken", "phoneNumberId", "appSecret"]);
      await whatsappApi({ accessToken, phoneNumberId }).checkCredentials();
      return { externalHandle: phoneNumberId };
    },
    /**
     * The verify token is generated once and kept stable across saves — the
     * Meta dashboard config keeps working after a token rotation.
     */
    saveCredentials: async ({ principal, credentials, botId }, creds) => {
      const { accessToken, phoneNumberId, appSecret } = required(creds, ["accessToken", "phoneNumberId", "appSecret"]);
      const keys = whatsappVaultKeys(botId);
      await credentials.set(principal, keys.accessToken, "org", accessToken);
      await credentials.set(principal, keys.phoneNumberId, "org", phoneNumberId);
      await credentials.set(principal, keys.appSecret, "org", appSecret);
      if (!(await credentials.has(principal, keys.verifyToken, "org"))) {
        await credentials.set(principal, keys.verifyToken, "org", randomBytes(24).toString("base64url"));
      }
    },
    webhook: "manual",
    webhookInfo: async ({ principal, credentials, botId, eventsUrl }) => {
      const verifyToken = await credentials.get(principal, whatsappVaultKeys(botId).verifyToken, "org");
      return [
        { label: "Callback URL", value: eventsUrl, copy: true },
        { label: "Verify token", value: verifyToken ?? "(save credentials first)", copy: Boolean(verifyToken) },
      ];
    },
  },
};

export const isDmChannelKind = (s: string): s is DmChannelKind => Object.hasOwn(CHANNEL_KINDS, s);
