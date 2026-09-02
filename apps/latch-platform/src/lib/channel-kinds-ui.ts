/**
 * The editor's view of each DM channel — plain data, safe to import client-side.
 * Everything the generic `ChannelSection` renders differently per kind lives
 * here; the behaviour behind the buttons is `channel-kinds.ts` (server).
 */

export type DmChannelKind = "telegram" | "whatsapp";

export interface CredentialFieldUi {
  key: string;
  placeholder: string;
  secret?: boolean;
}

export interface ChannelKindUi {
  label: string;
  /** One-paragraph pitch under the section title. */
  blurb: string;
  handlePlaceholder: string;
  createLabel: string;
  addAnotherLabel: string;
  /** How the platform-side handle shows on a bot row. */
  externalHandle:
    | { kind: "link"; text: (h: string) => string; href: (h: string) => string }
    | { kind: "text"; label: string };
  credentials: {
    title: string;
    /** Guidance shown above the fields; `link` is rendered as an anchor at the start. */
    link: { label: string; href: string };
    help: string;
    fields: CredentialFieldUi[];
    saveLabel: string;
    replaceLabel: string;
  };
  webhook:
    | { mode: "register"; statusRegistered: string; statusMissing: string }
    | { mode: "manual"; buttonLabel: string; help: string };
}

export const CHANNEL_KIND_UI: Record<DmChannelKind, ChannelKindUi> = {
  telegram: {
    label: "Telegram",
    blurb:
      "Give this agent its own Telegram bot. Users DM it and it answers as this agent — the reply arrives when the turn finishes, and tool approvals show up as inline buttons.",
    handlePlaceholder: "Handle (e.g. support-bot)",
    createLabel: "Create Telegram bot",
    addAnotherLabel: "Add another Telegram bot",
    externalHandle: { kind: "link", text: (h) => `@${h}`, href: (h) => `https://t.me/${h}` },
    credentials: {
      title: "Paste the BotFather token",
      link: { label: "@BotFather", href: "https://t.me/BotFather" },
      help:
        " → /newbot → copy the token it prints. Saving validates it and generates a fresh webhook secret — register the webhook after.",
      fields: [{ key: "botToken", placeholder: "1234567890:AAF…", secret: true }],
      saveLabel: "Save token",
      replaceLabel: "Replace token",
    },
    webhook: {
      mode: "register",
      statusRegistered: "webhook registered",
      statusMissing: "webhook NOT registered",
    },
  },

  whatsapp: {
    label: "WhatsApp",
    blurb:
      "Connect this agent to a WhatsApp business number via the Meta Cloud API. Users message the number and it answers as this agent; the reply arrives when the turn finishes.",
    handlePlaceholder: "Handle (e.g. support-whatsapp)",
    createLabel: "Connect WhatsApp",
    addAnotherLabel: "Add another WhatsApp bot",
    externalHandle: { kind: "text", label: "phone number id" },
    credentials: {
      title: "Paste the Meta app credentials",
      link: { label: "Meta App Dashboard", href: "https://developers.facebook.com/apps/" },
      help:
        ": a long-lived System User access token (the dashboard's temporary token dies in 24h), the Phone number ID (WhatsApp → API Setup), and the App secret (App Settings → Basic).",
      fields: [
        { key: "accessToken", placeholder: "Access token (EAAG…)", secret: true },
        { key: "phoneNumberId", placeholder: "Phone number ID (numeric)" },
        { key: "appSecret", placeholder: "App secret", secret: true },
      ],
      saveLabel: "Save credentials",
      replaceLabel: "Replace credentials",
    },
    webhook: {
      mode: "manual",
      buttonLabel: "Webhook config",
      help:
        "In the Meta dashboard (WhatsApp → Configuration → Webhook) paste both values, save (the deployment must be live — Meta verifies immediately), and subscribe to the messages field.",
    },
  },
};
