---
name: latch-whatsapp-setup
description: Connect a Latch agent to WhatsApp via the Meta Business Cloud API — provision Meta app credentials, verify the per-bot webhook, and link end-user identities. Use when a latch user wants their agent reachable via WhatsApp, either through the latch-platform UI or a custom host wiring @intentface/latch-channels/whatsapp.
---

# Connect a Latch agent to WhatsApp

Wires the WhatsApp channel (`@intentface/latch-channels/whatsapp`) to an
agent: one WhatsApp business number (Meta Cloud API) per agent, a per-bot
webhook into your deployment, one reply per turn (split past 4096 chars —
WhatsApp cannot edit messages), reply-button tool approvals, and per-user
identity linking keyed on the sender's phone number (`wa_id`).

## Prerequisites

- A running latch host. The reference host, `apps/latch-platform`, has the
  whole flow built in (tables are created automatically on boot).
- At least one agent.
- A Meta developer account. For development, a Meta app in dev mode with the
  free **test number** works without business verification — but it can only
  message up to 5 registered recipient numbers. Production needs Meta
  business verification.
- A publicly reachable HTTPS API origin — Meta verifies the callback URL the
  moment you save it in the dashboard.

| Env var | Required | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | yes | Canonical origin — the callback URL derives from it |
| `BETTER_AUTH_SECRET` | yes | Also signs the account-link tokens sent to unlinked users |

No global WhatsApp env vars: each bot's Meta credentials live in the org
Vault, pasted through the UI in step 2.

## 1. Collect the Meta credentials

In the [Meta App Dashboard](https://developers.facebook.com/apps/):

1. Create an app (type "Business") and add the **WhatsApp** product.
2. **Phone number ID** — WhatsApp → API Setup, under the sending number
   (the numeric ID, not the phone number itself).
3. **Access token** — create a **System User** (Business Settings → Users →
   System users), grant it the app + WhatsApp permissions, and generate a
   long-lived token. ⚠️ The dashboard's "temporary access token" expires
   after 24 hours — do not ship it.
4. **App secret** — App Settings → Basic. Signs webhook payloads
   (`X-Hub-Signature-256`).

## 2. Register the bot in Latch

In the platform UI, open the agent's editor (Agents → edit) and find the
**WhatsApp** section:

1. **Connect WhatsApp** → give the bot a handle.
2. Paste access token, phone number ID, and app secret → **Save
   credentials** — latch validates them against the Graph API and generates
   a webhook verify token (stable across credential rotations).
3. The **Webhook config** panel now shows the **callback URL** and **verify
   token**. In the Meta dashboard (WhatsApp → Configuration → Webhook):
   - paste both values and save — Meta immediately sends a GET
     `hub.challenge` to the URL, so the deployment must be live first;
   - subscribe to the **`messages`** webhook field.

## 3. End-user identity linking

1. A user WhatsApps the business number for the first time.
2. The bot replies with a signed link to `/whatsapp/link` (10-minute
   expiry) and holds the message.
3. The user opens it while logged into Latch; their WhatsApp number is
   linked to their Latch user and the held message **replays automatically**.
4. From then on turns run as the linked user; threads are per (bot, wa_id)
   and visible in the Latch web chat too.

Note: replying to inbound messages is always allowed; Meta's 24-hour
customer-service window only restricts business-initiated (template)
messages, which this channel does not send.

## 4. Local development (tunnel)

```sh
cloudflared tunnel --url http://localhost:3000   # or ngrok http 3000
```

Set `PUBLIC_BASE_URL` to the tunnel origin, restart, and re-paste the new
callback URL into the Meta dashboard (Meta re-verifies on save). For the
dev-mode test number, add your personal WhatsApp number as a recipient under
API Setup.

Verify the handshake manually:

```sh
curl "https://<origin>/api/whatsapp/<botId>/events?hub.mode=subscribe&hub.verify_token=<verifyToken>&hub.challenge=ping"
# → 200 "ping"
```

## 5. Custom host wiring (non-latch-platform)

```ts
import { whatsappChannel } from "@intentface/latch-channels/whatsapp";

const channel = whatsappChannel({
  agent: "support",
  botRef: bot.id,
  accessToken: () => vault.get("whatsapp_access_token"),
  phoneNumberId: () => vault.get("whatsapp_phone_number_id"),
  appSecret: () => vault.get("whatsapp_app_secret"),
  verifyToken: () => vault.get("whatsapp_verify_token"),
  runtime, // { handleChat, applyApproval, loadHistory }
  authorizeUser: async ({ waId }) => {
    const identity = await myStore.resolve(waId);
    return identity
      ? { allowed: true, principal: identity.principal }
      : { allowed: false, linkUrl: mySignedLinkUrl(waId) };
  },
  seen: (key) => myStore.seenDelivery(key),
  claimTurn: (chatId) => myStore.claimTurn(chatId),
  releaseTurn: (chatId) => myStore.releaseTurn(chatId),
});

// GET is Meta's hub.challenge handshake; POST carries events:
app.get("/api/whatsapp/:botId/events", (c) => channel.handleRequest(c.req.raw));
app.post("/api/whatsapp/:botId/events", (c) => channel.handleRequest(c.req.raw));
```

## 6. Verification checklist

- [ ] The `curl` handshake above returns the challenge with HTTP 200.
- [ ] Meta dashboard shows the webhook as verified with `messages`
      subscribed.
- [ ] First message from an unlinked number gets a setup link; after
      linking, the held message replays automatically.
- [ ] A linked text message gets one reply when the turn finishes; a very
      long answer arrives as several sequential messages.
- [ ] Sending an image works — media is downloaded via the Cloud API and
      reaches the agent as multimodal input (≤10 MB per file).
- [ ] An approval-gated tool shows ✅ Approve / 🚫 Deny reply buttons;
      tapping Approve resumes the run.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Meta says callback verification failed | Deployment not reachable, or verify token mismatch — copy it again from the Webhook config panel |
| POSTs arrive but are rejected (401) | Wrong **app secret** (signature verification fails) — re-save credentials |
| "whatsapp:checkCredentials failed" on save | Token expired (24 h temp token?) or phone number ID belongs to another app |
| Bot works for you but not colleagues | Dev-mode app: only registered test recipients (max 5) can message the test number |
| Replies stop after ~24 h of silence | Not applicable to replies-to-inbound; if seen, check token expiry |
| Voice notes get "I can't hear audio" replies | Audio passes through as `audio/ogg`; model-dependent |
