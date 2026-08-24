---
"@intentface/latch-channels": patch
---

Fix `chat.startStream` failing with `invalid_arguments` (observed live: every
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
