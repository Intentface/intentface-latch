---
name: latch-telegram-setup
description: Connect a Latch agent to Telegram — provision a BotFather bot, save the token, register the per-bot webhook, and link end-user identities. Use when a latch user wants their agent reachable via Telegram DMs, either through the latch-platform UI or a custom host wiring @intentface/latch-channels/telegram.
---

# Connect a Latch agent to Telegram

Wires the Telegram channel (`@intentface/latch-channels/telegram`) to an
agent: one Telegram bot (from BotFather) per agent, a per-bot webhook into
your deployment, streaming replies (live message edits), inline-keyboard tool
approvals, and per-user identity linking.

## Prerequisites

- A running latch host. The reference host, `apps/latch-platform`, has the
  whole flow built in (tables are created automatically on boot — no manual
  migration). For a custom host, see "Custom host wiring" below.
- At least one agent.
- A publicly reachable HTTPS origin for the API — Telegram only delivers
  webhooks to HTTPS URLs with valid certificates (tunnel for local dev, §4).

| Env var | Required | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | yes | Canonical origin — webhook + link URLs derive from it (`lib/base-url.ts` falls back to `BETTER_AUTH_URL`, then the Vercel URL) |
| `BETTER_AUTH_SECRET` | yes | Also signs the account-link tokens the bot DMs to unlinked users |

No global Telegram credentials exist: each bot's token and webhook secret
live in the org Vault, pasted through the UI in step 2.

## 1. Create the bot with BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. `/newbot` → choose a display name → choose a username (must end in `bot`,
   e.g. `acme_support_bot`).
3. Copy the token BotFather prints (`1234567890:AAF...`). Treat it as a
   secret.
4. Privacy mode does NOT need changing — the channel only handles direct
   messages, and DMs always reach the bot regardless of privacy mode.

## 2. Register the bot in Latch

In the platform UI, open the agent's editor (Agents → edit) and find the
**Telegram** section:

1. **Create Telegram bot** → give it a handle.
2. Paste the BotFather token → **Save token** — latch validates it against
   Telegram's `getMe` (the row shows the bot's `@username`) and generates a
   server-side webhook secret. ⚠️ Every token save rotates the secret, so:
3. Click **Register webhook**. Latch calls Telegram's `setWebhook` with
   `https://<PUBLIC_BASE_URL>/api/telegram/<botId>/events` and the secret
   token. Use the **Status** button to confirm: your URL, ~0 pending
   updates, no last error.

## 3. End-user identity linking

1. A user DMs the bot for the first time.
2. The bot replies with a signed link to `/telegram/link` (10-minute
   expiry) and holds the message.
3. The user opens it while logged into Latch; their Telegram account is
   linked to their Latch user, and the held message **replays
   automatically** — the answer arrives in Telegram without re-sending.
4. From then on turns run as the linked user (per-user isolation); thread
   continuity is per (bot, Telegram user), and the same conversation is
   visible in the Latch web chat.

A Telegram account already linked to a different Latch user is refused
(`?telegram=link_conflict`) — links never silently change owners.

## 4. Local development (tunnel)

```sh
cloudflared tunnel --url http://localhost:3000   # or ngrok http 3000
```

Set `PUBLIC_BASE_URL` to the tunnel origin, restart, and hit **Register
webhook** again. **Every time the tunnel URL changes you must re-register
the webhook** — Telegram keeps delivering to the old URL otherwise.

## 5. Custom host wiring (non-latch-platform)

The adapter is pure protocol translation — you inject state:

```ts
import { telegramChannel } from "@intentface/latch-channels/telegram";

const channel = telegramChannel({
  agent: "support",
  botRef: bot.id, // your bot row's id — appears in chat ids
  botToken: () => vault.get("telegram_bot_token"),
  webhookSecret: () => vault.get("telegram_webhook_secret"),
  runtime, // { handleChat, applyApproval, loadHistory }
  authorizeUser: async ({ telegramUserId }) => {
    const identity = await myStore.resolve(telegramUserId);
    return identity
      ? { allowed: true, principal: identity.principal }
      : { allowed: false, linkUrl: mySignedLinkUrl(telegramUserId) };
  },
  seen: (key) => myStore.seenDelivery(key), // durable dedupe, 10-min TTL
  claimTurn: (chatId) => myStore.claimTurn(chatId), // one turn per chat
  releaseTurn: (chatId) => myStore.releaseTurn(chatId),
});

// Mount on any web-standard framework:
app.post("/api/telegram/:botId/events", (c) => channel.handleRequest(c.req.raw));
```

Note the contract difference vs the Slack channel: `authorizeUser` RESOLVES
the per-user principal (Slack's is a yes/no gate and runs turns as the owner).

## 6. Verification checklist

- [ ] Webhook status shows your events URL, `pendingUpdateCount` near 0, no
      `lastErrorMessage`.
- [ ] First DM from an unlinked account gets a setup link within seconds;
      after linking, the held message replays automatically.
- [ ] A linked DM streams its reply — the message visibly grows via edits;
      tool use shows an italic "Running <tool>…" status line.
- [ ] A >4000-char answer is truncated with a notice (one message, no spill).
- [ ] Sending a photo or document works — it reaches the agent as multimodal
      input (≤10 MB per file; Telegram's own bot-download cap is 20 MB).
- [ ] A second message while a turn is running gets "still working" —
      expected, one turn per chat at a time.
- [ ] An approval-gated tool shows ✅ Approve / 🚫 Deny inline buttons;
      approving resumes the run; `connect_*` approvals show an OAuth link.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Webhook status shows 401/404 errors from Telegram | Events URL wrong or app not deployed — re-register after fixing `PUBLIC_BASE_URL` |
| Updates arrive but bot never replies | Wrong secret token — re-save the bot token, then **Register webhook** again (saves rotate the secret) |
| "telegram:getMe failed" on save | Token typo or bot deleted in BotFather |
| Bot replies with a setup link every time | The link was never opened while logged in, or the account is linked under a different Latch user |
| Reply arrives as plain text with literal `**` | HTML parse failed once and the turn fell back to plain text — cosmetic, self-heals next turn |
| Voice notes get "I can't hear audio" replies | Audio passes through as `audio/ogg`; whether the model accepts it depends on the agent's model |
| Group messages ignored | By design — v1 handles private chats only |
