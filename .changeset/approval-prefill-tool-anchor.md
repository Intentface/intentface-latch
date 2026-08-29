---
"@intentface/latch-core": patch
---

Resuming an approved turn no longer dies on providers that reject assistant prefill. `trimTrailingAssistantPrefill` anchored on the last tool-ish part of the paused assistant message — but it accepted a bubbled `data-subagent-approval` marker as that anchor, and `data-*` parts are stripped before the model sees anything, so the narration the model streamed around the pause ("Once approved, it'll be…") stayed as the projection's last visible content. Providers without prefill support refuse that conversation, so clicking Approve in the agent builder produced an error instead of a continuation — intermittently, since it needed the model to have narrated before pausing.

The trim now anchors only on parts the model projection keeps (`tool-*` / `dynamic-tool`), drops trailing `text`/`reasoning`/`step-start` (`step-start` included: it opens a new assistant message in conversion, which — with the text gone — would be empty, trading the prefill rejection for an empty-content one), and keeps the `data-*` approval markers, which the resumed turn re-persists and the UI and `hasPendingApproval` depend on.
