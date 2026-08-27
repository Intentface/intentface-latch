# @intentface/latch-channels

## 0.6.0

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0

## 0.5.0

### Patch Changes

- a5ec8cf: Document that `chat.postMessage`'s `markdown_text` is exclusive with
  `text`/`blocks` (`markdown_text_conflict`) — combining them fails every call.
- 835bef6: Streamed answers can no longer vanish. Observed live: Slack expires an idle
  stream while the model thinks after a tool result, every later append bounces
  with `message_not_in_streaming_state`, and the final text was silently
  dropped (the web UI showed it; Slack never did). Now the renderer flips to
  the post+update engine on a fresh message the moment a stream is dead, and a
  failed close posts the undelivered tail as a regular message — degraded
  rendering is allowed, lost text is not.
  
  Also from the same live session: task cards left open by an approval-parked
  turn settle before the stream closes (no more misleading ⚠️ on gated tools),
  and approval-resume streams — which carry no tool names — render "Using
  <tool>" from the resumed approval instead of a blank title.
- @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- d7b84af: Fix `chat.startStream` failing with `invalid_arguments` (observed live: every
  turn degraded to the post+update fallback, visible as "(edited)" answers).
  The streaming methods now send real JSON bodies instead of JSON-in-form, and
  `task_display_mode` is no longer sent on start. `SlackApiError` now carries
  Slack's `response_metadata.messages` detail (the JSON pointer that names the
  offending argument), so any future argument rejection is self-diagnosing.
  
  Also: the renderer reports its engine decision via the new `onStreamMode`
  config hook (hosts persist it for binding health), and drives the legacy
  free-text status box ("is thinking…", "is using web_search…") via the new
  `setStatus` hook in the surfaces that render it — best-effort, revisit before
  Slack's Feb 2027 assistant-API sunset.
- @intentface/latch-core@0.4.1

## 0.4.0

### Minor Changes

- e25e727: Slack channel v2 — a ground-up rewrite of the adapter. **Breaking** for hosts
  of the Slack subpath.
  
  The webhook now ACKs after signature verification and a minimal parse only;
  every DB/Vault/history read happens in deferred workers, killing the 3s-retry
  storms at the source. Admission is atomic by construction: a single
  `claimOnce` TTL primitive dedupes deliveries, message shapes and interaction
  retries, and a token-fenced `claimTurn` lease guarantees one live run per
  chat (replacing the best-effort `isBusy` scan). Threads are initiator-owned:
  the chat records who started it, bystanders get one quiet notice, and
  approval buttons carry HMAC-signed, actor-bound, expiring payloads. New
  `slack2_` chat ids are app-scoped with a per-DM-channel `dm` root, giving
  plain DMs continuous history; v1 ids and the legacy-adoption seam are gone.
  
  Rendering moves to Slack's native streaming (`chat.startStream`/`append`/
  `stop`) with tool calls as task cards, reasoning as one collapsed task,
  markdown blocks for real headings/tables/code, a native Stop button
  (`agent_session_stopped` + in-band `stopped_by_user`), optional feedback
  buttons, and a post+update fallback engine. The manifest targets the new
  `agent_view` (Agent Sessions) surface — the deprecated assistant framework is
  out — and subscribes to session/lifecycle events; scopes gain `groups:read`
  and `channels:join` for membership-gated reads.
  
  Host contract changes: config requires `appId`, `botUserId`, `teamId`,
  `claimOnce`, `claimTurn`/`releaseTurn` and a `threads` store; `seen`,
  `isBusy`, `isFollowedThread`, `chatNamespace` and `resolveChatId` are
  removed; `onLifecycle` (uninstall/revocation), `feedback`/`onFeedback` and
  `suggestedPrompts` are new. The adapter finally has a behavioral test suite
  (29 cases pinning ACK discipline, double-fire dedupe, ownership, actor-bound
  approvals, session stop and lifecycle).
- 2cabdfe: Slack v2 groundwork: hardened Web API client and the new pure modules.
  
  `slackApi` now throws typed `SlackApiError`s (method, status, Slack error
  code, retry-after), honors `Retry-After` on 429 with one bounded retry,
  retries 5xx once, applies a request timeout, and takes injectable
  `fetchImpl`/`sleep`/`baseUrl` options for tests. New methods: the streaming
  trio (`startStream`/`appendStream`/`stopStream` with typed chunks), agent
  sessions (`sessionsSetStatus`/`sessionsRename`), `setSuggestedPrompts`,
  `conversationsMembers` (paginated, fails closed on truncation),
  `conversationsInfo`, `conversationsHistory`, `authTest`, and
  `postMessage`/`update` gain `markdown_text`.
  
  Also ships (internal until the v2 channel lands): the `slack2_` chat-id
  scheme with per-DM-channel continuity, inbound message normalization that
  handles mid-text mentions, HMAC-signed interaction payloads with expiry, the
  native-streaming renderer with task cards and a post+update fallback, and
  `markdown`-block builders. All new modules are fully unit-tested.

### Patch Changes

- @intentface/latch-core@0.4.0

## 0.3.1

### Patch Changes

- f28ef9c: Slack: dedupe on the message, not the delivery — a mention inside a DM ran the turn twice.
  
  Slack delivers one message as several events with distinct `event_id`s: a mention **inside a DM**
  arrives as both `app_mention` and `message.im`, and the dispatch gate accepts each. The existing
  dedupe is keyed on `event_id` (Slack's retry identity), so it saw two different ids and let both
  through — two turns milliseconds apart on one message, each a full billed model call. Observed in
  production: overlapping runs 151 ms apart.
  
  Turn-running paths now also claim `(channel, ts)` — the message's identity across every event shape
  it arrives in — through the same atomic `seen()` store. Claimed only where a turn actually runs, so
  an ignored event never consumes it.
- @intentface/latch-core@0.3.1

## 0.3.0

### Minor Changes

- ddfa57b: Slack threads are scoped to the app that owns them.
  
  `slackChatId` gains an app segment (`slack_<app>_<channel>_<root>`) and `slackChannel` a
  `chatNamespace` option to supply it. Without it, every bot in a channel shared **one** Latch chat
  per thread — because they all receive `message.channels` for the same message. Two consequences,
  both observed in production: each bot's `isFollowedThread` saw the other bots' replies as its own
  history, so a single un-mentioned follow-up was answered by **every** bot in the channel; and they
  read and wrote one interleaved history, so an agent answered out of another agent's conversation.
  
  `parseSlackChatId` still parses legacy unscoped ids (and now returns `app` when present). For
  threads that predate scoping, `slackChannel` also takes `resolveChatId({ scoped, legacy })`: a host
  returns the legacy id when a chat exists there **and belongs to this agent**, and the scoped id
  otherwise — so the bot that owns an existing thread keeps its history while the other bots that
  were sharing that chat fall through to their own. Without the hook an existing thread would switch
  to a scoped id and its history would go invisible (plain replies unfollowed, a later mention
  starting an empty chat).
  
  Hosts should pass `chatNamespace`, and `resolveChatId` if they have threads from before the fix.

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0

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
