---
"@intentface/latch-channels": minor
---

Slack channel v2 — a ground-up rewrite of the adapter. **Breaking** for hosts
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
