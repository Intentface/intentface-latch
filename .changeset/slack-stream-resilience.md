---
"@intentface/latch-channels": patch
---

Streamed answers can no longer vanish. Observed live: Slack expires an idle
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
