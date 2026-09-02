# @intentface/latch-channels

Bring a Latch agent to the places people talk — Slack, Telegram, WhatsApp. Reuses the core runtime, storage and durability (no separate state store); identity (platform user → Principal) and channel → agent binding stay in user-land, per Latch's isolation model.

## What it does

- **Generic core (`.`)** — the platform-agnostic half:
  - `consumeRun(response)` → `AsyncIterable<RenderEvent>` folded from the runtime's SSE `Response`; `pendingApprovals` / `pendingQuestion` read what a paused turn is waiting on from persisted history. Adding a platform is "translate `RenderEvent`s", never "re-parse the AI stream."
  - `createTurnKernel(config, surface)` — everything a direct-message surface does between "a webhook arrived" and "the platform API was called", written once: dedupe, the identity gate (with stash + post-link replay), thread epochs (`/new`), commands, questionnaires, the one-turn-per-chat lease (`withTurnLease`), media folding (files inline, voice transcribed), the answer posted **once at finish** (split past the cap; a typing hint meanwhile), approvals and button taps back into the run. A `Surface` is pure protocol: send text / link / approval / question, edit or retire a card, download a file.
  - `AuthResult`, the `lta:` / `ltq:` button-payload codecs, `splitText`.
- **Telegram (`./telegram`)** and **WhatsApp (`./whatsapp`)** — a webhook parser plus a `Surface` each, over the kernel. `telegramChannel(config)` / `whatsappChannel(config)` verify the webhook, ACK fast, and run the turn in the background (`waitUntil`).
- **Slack (`./slack`)** — `slackChannel(config)`: one agent's dedicated app; native message streaming with tool calls as task cards, initiator-owned threads, signed actor-bound approval buttons, atomic admission (`claimOnce` + the shared turn lease). Plus the per-agent app manifest generator, a minimal Web API client and hand-rolled Block Kit (no Chat SDK runtime dependency). Slack keeps its own engine because its surface is threads, not DMs.

## Usage

```ts
import { telegramChannel } from "@intentface/latch-channels/telegram";

const channel = telegramChannel<Principal>({
  agent, botRef, botToken, webhookSecret,
  runtime: { handleChat, applyApproval, applyToolResult, compactChat, loadHistory },
  authorizeUser, seen, claimTurn, releaseTurn, stashPending, askState, thread, waitUntil,
});
return channel.handleRequest(request); // one webhook route per bot
```

A new DM platform: implement `Surface<User, Ref>` and a parser from your webhook body to `Inbound<User, Ref>`, then `createTurnKernel(config, surface).handleInbound(event)`.
