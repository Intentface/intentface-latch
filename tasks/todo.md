# Eval loop for Agent Builder — v1

Design approved in chat 2026-07-20. Scope: assertion + tool-call graders, no LLM judge yet.

## Plan

- [x] 1. Eval store (`apps/latch-platform/src/lib/evals/store.ts`)
  - Tables `latch_eval_sets`, `latch_eval_runs` (owner-scoped like `latch_agents`)
  - Case shape: `{ id, name, input, expected: { assertions?, toolCalls?, forbiddenTools? } }`
  - Run row pins `agent_snapshot` (resolved config at run time)
- [x] 2. Graders (`apps/latch-platform/src/lib/evals/grade.ts`)
  - `contains` / `not_contains` / `regex` on answer text
  - tool-call assertions: called tool X (with optional arg matchers), did NOT call Y
- [x] 3. Runner (`apps/latch-platform/src/lib/evals/run.ts`)
  - Fan cases through `runtime.runAgent` (blockGated, sub-threads), concurrency-capped (4)
  - Grade, return per-case results; crashes captured as failed results
- [x] 4. Builder tools in `agent-builder.ts`
  - `save_eval_set` + `run_evals` (both approval-gated), `list_eval_sets`, `list_eval_runs`
  - Prompt: new EVALS section + workflow step 7 (eval it) + regression note on MODIFYING
- [x] 5. Chat UI eval card
  - Generic `renderTool` prop on `<Message>` (latch-ui) — custom renderer per tool part
  - `EvalRunCard` (`components/eval-run-card.tsx`): pass bar, delta vs previous run,
    per-case rows expandable to the full sub-thread transcript via `loadHistory`
  - Tool labels for the four eval tools in `DEFAULT_TOOL_LABELS`
- [x] 6. Verify

## Review (2026-07-20)

Shipped v1 of the create → eval → improve → re-eval loop, fully inside the builder chat.

**Verification:** `tsc --noEmit` clean; eslint clean on all new/changed files (remaining
chat.tsx warnings pre-existing); 14 vitest tests pass (grader unit tests, runner with a
stubbed runtime, store integration tests against in-memory libsql); `vite build` succeeds.
These are the repo's first tests — vitest was configured but unused.

**Key decisions:**
- No agent-version table yet: each run stores `agent_snapshot` (the full AgentRecord at
  run time), which is enough for honest run-over-run comparison. Revert-to-version is v3.
- `run_evals` is approval-gated (costs one agent run per case) and always safe-mode
  (`blockGated: true`); case transcripts live in hidden `sub_` threads.
- Case ids are stable slugs so history stays comparable across set edits.
- LLM-judge rubric grading and promote-from-chat deferred to v2. (Live progress
  streaming was originally deferred too, but shipped in v1 after the freeze
  report — see the fix entries below.)

**Not yet manually smoke-tested** in the running app (needs dev server + API key):
build an agent in the builder chat, save an eval set, run it, expand a failing case.

## Fix: live progress streaming (2026-07-21)

User report: UI froze on the run_evals approval dialog — no stream chunks for the
minutes the cases run. Fixed by streaming a `data-eval-progress` part from inside
the tool via `options.context.writer` (reconciled in place by part id):

- `run.ts`: `runEvalCases` gained `onResult(result, completed, total)`.
- `store.ts`: shared `CompactCaseResult` + `EvalProgressData` types, `compactResult`.
- `agent-builder.ts`: run_evals writes progress at start and per completed case;
  prompt tells the model not to re-narrate cases (the card shows them).
- `EvalRunCard`: renders live `completed/total` + rows ticking in while running
  (matched to the tool call by `toolCallId`); final output view unchanged.

Verified: tsc, eslint, 15 tests, vite build. Caveat for prod: one run_evals call
holds the serverless function for the whole run — check Vercel duration limits.

## Fix: poisoned chat after interrupted approved tool (2026-07-21)

User report: every turn in the builder chat 400s — "`tool_use` ids found without
`tool_result` blocks" (Anthropic). Diagnosed against the dev DB: the frozen
run_evals from yesterday was APPROVED, execution was killed mid-run (reload/dev
restart), so its part persisted as `approval-responded` + approved + NO output.
`closeDanglingToolCalls` (core `projections.ts`) deliberately skipped decided
approvals ("the re-run executes them") — true only at the TAIL of history. Once
a later message buries the call, nothing ever executes it and every model call
rejects.

Fix: the projection now also closes approved-no-output calls when they are not
in the final message (synthetic "interrupted" result; stored history untouched).
Tail-position approved calls still re-execute; denied approvals still get the
SDK's denial result. Poisoned chats self-heal on the next turn — no DB surgery.

Verified: 3 new regression tests in `model-projection.test.ts` (buried approved,
buried interrupted, completed calls untouched) + a one-off projection of the
REAL poisoned chat from latch.db (balanced tool_use/tool_result, then deleted
the local-DB-dependent test). tsc, eslint, 18 tests, vite build all green.

## Fix: eval progress actually visible in the browser (2026-07-21)

User report: still no streaming — approve element "flashing". THREE client-side
causes found by driving the real app (claude-in-chrome, localhost:3000):

1. The decision is only recorded server-side; the continuation stream doesn't
   re-emit the tool part until it has output, so the client part stayed
   `approval-requested` for the whole run → renderApproval kept winning over the
   card. Fix: `applyLocalDecision` in chat.tsx optimistically mirrors the
   server's applyDecisions before consuming the stream (+ EvalRunCard treats
   `approval-responded`+approved as executing, shows "Denied" when denied).
2. The resume-poll clobbered streamed state: yesterday's crashed run stayed
   `running` forever (dev never reaps), so the 2s history poll ran permanently,
   overwriting messages with server history that lacks streamed-only parts.
   Fixes: poll skips setMessages while `deciding` (continuation active), and the
   dev interval in latch.ts now also calls `runtime.tick()` to reap crashed runs.
3. `evalProgressFor` now searches all messages, not just the tool part's own.

Verified end-to-end IN THE RUNNING APP: approve → card flips instantly to
"Evals · running-coach · default ⟳" → "0/14" within seconds → "5/14" with case
rows ticking in live → final "14/14 passed · +2" with delta. Full builder loop
observed: 12/14 run → builder diagnosed failures → patched instructions →
re-ran → 14/14. Plus integration test `eval-approval-stream.integration.test.ts`
(real runtime + mock model: progress chunks on the wire before the tool result,
client reader materializes them). 19 tests green, tsc green.
