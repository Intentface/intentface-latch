# @intentface/latch-channels

## 0.2.0

### Minor Changes

- 80f0c86: Slack: `authorizeUser` is now a resolver — per-message principals, so each member acts with their own credentials.
  
  `authorizeUser` may return `principal` alongside `allowed: true`; that message's turn (and its
  history reads, approval resumes, and rendered follow-ups) runs as that principal instead of the
  tenant's. This is how a shared channel bot stops running everyone through the installer's
  credentials — a data-exposure problem, not just an attribution one. The principal is opaque to
  the channel; the host decides how it encodes "shared thread, per-user credentials".
  
  Approve/Deny interactions are now gated and resolved the same way: the resume re-runs the agent
  with tool access, so the CLICKER must pass `authorizeUser` (an unlinked bystander can no longer
  approve gated tools), and the resumed turn runs as the clicker. `resumeApproval` accepts an
  optional `principal` for the same reason.
  
  Hosts whose `authorizeUser` returns no principal keep the previous behavior exactly.
- a6ddc59: Slack: `resumeApproval` — continue a thread after a connection's OAuth completes in the browser.
  
  The sign-in card a Slack thread renders for an unauthorized connection sends the user to a
  browser OAuth flow; until now nothing brought the result back, so the parked `connect_<name>`
  approval never resolved and the conversation dead-ended. `slackChannel(...)` now also returns
  `resumeApproval({ chatId, approvalId, userId, tenant? })`: it approves the parked connect
  approval and renders the resumed run into the thread.
  
  Deliberately restricted to CONNECT approvals, verified against fresh history — unlike the
  Approve/Deny buttons (whose payloads arrive Slack-signed), this entry point is reached from a
  browser redirect, so an approvalId alone must not be able to approve an arbitrary gated tool.
- dd8aea8: Slack: structural guards against a thread running away.
  
  Observed in production: one thread produced **22 agent runs from ~3 real exchanges**, in bursts of
  5–8 concurrent turns, with 44 Slack events — the bot answering its own posts. Three fixes, each
  independently sufficient to have prevented it:
  
  - **`botUserId` config** — the authoritative self-check. `bot_id`/`subtype` are absent on some post
    shapes, and a self-message that slips through the thread-following gate makes the bot answer
    itself and post again. Comparing `event.user` to the bot's own id can't miss. Omitted → previous
    `bot_id`/`subtype` behaviour.
  - **`isBusy` config** — a circuit breaker checked before every inbound turn (mentions, DMs and
    thread-following alike): never stack turns on one chat. A feedback loop can outrun any single
    filter; this caps the blast radius to one turn. Omitted → no cap.
  - **Interaction dedupe + ACK-first.** `block_actions` deliveries are retried by Slack exactly like
    events, and the resume one triggers is a full agent turn — they now go through the same atomic
    `seen()` dedupe (keyed on `trigger_id`), and tenant resolution moved *after* the ACK so a cold
    start can't blow Slack's 3s window and earn a retry in the first place.

### Patch Changes

- db68702: Slack manifests now fit the create-app wizard's real description limit.
  
  The manifest reference documents 140 characters for `display_information.description`, but the
  "create from manifest" wizard enforces the app-listing limit of 100 — a longer description is
  rejected as "too long", and on the review page the confirm button just stays disabled with no
  visible error. Generated manifests now trim the description to 100 characters at a word boundary.
- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
