---
"@intentface/latch-channels": minor
---

Slack v2 groundwork: hardened Web API client and the new pure modules.

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
