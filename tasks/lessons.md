# Lessons

## Long-running tool calls must stream progress from day one (2026-07-21)

**What happened:** v1 of the eval loop deferred live progress to "v2". A 14-case
`run_evals` call takes minutes with zero stream chunks, so the chat UI sat frozen
on the approval dialog — the user read it as a hang.

**Rule:** any tool whose execution is longer than a few seconds (fan-out runs,
batch jobs, migrations) needs a progress channel in the SAME change, not a
follow-up. In this codebase the mechanism is cheap: every tool's `execute`
receives `options.context.writer` (the turn's `TurnWriter`,
`packages/core/src/runtime.ts:790-800`); write a `data-<name>` part with a stable
`id` and it reconciles in place on the client. Budget it into v1 scope.

**Corollary:** "streams to the UI" is part of done for chat-surfaced features —
verify the silent window between user action and first chunk, not just the final
render.

## Streaming UX must be verified in the real browser (2026-07-21)

**What happened:** I "fixed" eval-progress streaming and verified with an
integration test (server chunks + stream-reader semantics) — but the user's
browser still showed a frozen approval card. Three purely client-side causes
(stale approval state, a background poll clobbering streamed state, a stale
`running` run keeping that poll alive forever) were invisible to any test below
the real UI.

**Rule:** for streaming/interactive UI features, the verification bar is the
real running app: click the actual button, watch the actual pixels change over
time (multiple screenshots seconds apart). Integration tests prove mechanisms;
only the browser proves the feature. Use claude-in-chrome against the dev
server; check for OTHER writers to the same client state (polls, reconcilers,
optimistic updates) — a correct stream loses to a 2-second overwrite loop.

## Code-declared agents need a dev-server restart (2026-07-21)
Editing code-declared agents (src/agents/*) or anything the getLatch()/runtime
singleton captures is NOT picked up by vite HMR — the running server keeps the
old agent definitions/prompts. Symptom: new subagents/tools/prompt sections
silently absent (builder behaved as if spawn_agent didn't exist). Fix: restart
`pnpm dev`. Check `ps -o lstart -p $(lsof -ti :3000)` vs your edit time before
trusting live behavior.

## A denied-tool turn steers later turns in the same chat (2026-07-21)
After a denial + inline draft in context, the builder reused its drafted cases
instead of following new prompt rules (delegation). When verifying prompt-level
behavior changes, use a FRESH chat — old chats carry momentum that masks them.
