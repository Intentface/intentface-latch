# @intentface/latch-channels

Bring a Latch agent to the places people talk — **Slack first**, Teams/Discord/etc. later. Reuses the core runtime, storage, and durability (no separate state store).

## What it does

- **Generic core (`.`)** — turn a Latch run into normalized, surface-agnostic events:
  - `consumeRun(response)` → an `AsyncIterable<RenderEvent>` (text / reasoning / tool-start / tool-end / status / finish) folded from the runtime's SSE `Response`.
  - `pendingApprovals(messages)` → the parked HITL approvals to render (incl. `connect_*` OAuth ones), read from persisted history.
  - So adding a platform is "translate `RenderEvent`s", never "re-parse the AI stream."
- **Slack adapter (`./slack`)** — `slackChannel(config)`: verifies the signature → fast-ACKs → runs the turn in the background (`waitUntil`) → streams status + the answer to the thread → renders **Approve/Deny** buttons (click → `applyApproval`). Plus the per-agent app **manifest** generator, a minimal Slack Web API client, and hand-rolled Block Kit (no Chat SDK runtime dependency). Decoupled from the app via injected `SlackRunOps`, `seen` (dedupe), `authorizeUser` (the identity gate), and `isFollowedThread` (thread-following).

## Usage

```ts
import { slackChannel } from "@intentface/latch-channels/slack";

const channel = slackChannel<Principal>({
  agent, principal, botToken, signingSecret,
  runtime: { handleChat, applyApproval, loadHistory },
  waitUntil, seen, authorizeUser, isFollowedThread,
});
return channel.handleRequest(request); // one webhook route per app
```

## Where it fits

Sits beside `@intentface/latch-core`. Identity (platform-user mapping) and channel→agent binding stay in user-land per Latch's isolation model. eve (`vercel/eve`) is the reference for this design.
