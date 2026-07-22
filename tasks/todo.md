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

---

## Eval-author subagent (plan: ~/.claude/plans/cuddly-hopping-prism.md)

- [x] evalStore.getRun(owner, id)
- [x] shared-read-tools.ts (get_agent, list_eval_sets, list_connection_tools extracted)
- [x] agents/eval-author.ts (read-only tools + get_eval_run + read_transcript; AUTHOR/DIAGNOSE JSON contract)
- [x] register in agents/index.ts
- [x] agent-builder: subagents:["eval-author"], RESERVED_NAMES, EVALS section rewrite (always delegate)
- [x] tests: getRun round-trip, spawn_agent delegation integration, get_eval_run/read_transcript
- [x] pnpm typecheck + pnpm test green (from apps/latch-platform)
- [x] live browser verification (fresh builder chat; nutrition set)

Verified end-to-end IN THE RUNNING APP (fresh builder chat, running-coach agent):
builder briefed eval-author via spawn_agent ("Delegated to eval-author" thread in
UI) → strict-JSON cases came back with REAL tool names (runner-kn_orient, self-
discovered via get_agent) → curation table → approved save_eval_set → run_evals
live card 4/5 → builder auto-delegated diagnosis to the SAME eval-author thread
(DB: one sub_ chat, 6 messages across author + 2 diagnose rounds) → get_eval_run
+ read_transcript used live → verdict fixTarget:"case" (false-positive "I can't")
applied + saved → re-run → 3/5 (real agent bug: web_fetch instead of orient) →
verdict fixTarget:"agent" → builder proposed save_agent instruction fix (left
pending for the user). 25 vitest tests green, tsc green.

---

## Grader tiers roadmap (grilled + approved 2026-07-22)

Order: commit eval-author work first, then 1 → 2 → 3. Item 4 (multi-turn) waits
for a real motivating failure.

- [x] 0. Ship pending eval-author work: code review, commit, push to PR #6
  (agent review: no blockers; fixed read-only-invariant test gap +
  read_transcript empty-thread error + built-in-agent instruction caveat;
  pushed eedde18)
- [x] 1. Richer deterministic trajectory checks (grade.ts + schemas, no deps)
  - `expected.toolOrder: string[]` (subsequence), `{"$regex"}` arg matchers
    (through isRiskyRegex/safeRegexTest, save-time validated), `maxCalls` per
    tool, `maxTotalToolCalls` per case. Token budget SKIPPED — needs usage
    plumbing from core runAgent; revisit if step budget proves insufficient.
- [x] 2. Flakiness as a number (run.ts + store + card)
  - per-case `repeats: 2..5` opt-in, majority verdict (floor(n/2)+1); attempts
    fan through the SAME mapPool (no serialization); per-attempt results
    persisted on the case result; run_evals reports attempt-level passRate +
    pp delta (runPassRate degrades old boolean history gracefully); progress
    counts attempts, card gets per-row "2/3 runs" chip + case-based bar
- [x] 3. LLM-judge rubric tier — SHIPPED per the grilled design (all bullets
  below implemented; judge meta-eval passed 3/3 against the REAL pinned Haiku
  via LIVE_JUDGE=1; catalog confirms claude-haiku-4-5 at $1/$5 per 1M):
  - Pass semantics: rubric criterion fail = CASE FAIL (one honest verdict);
    verdicts in a distinct result field; judge INFRA errors never fail a case;
    deterministic fail always fails regardless of rubric
  - Judge model: code-pinned Haiku-class constant, resolved via catalog with an
    explicit existence check (no silent modelFor fallback), temperature 0,
    `judgeModelId` recorded on every run row
  - Call structure: ONE JUDGE CALL PER CRITERION, strict JSON {pass, reason}
  - Judge context: case input + FULL answer + compact tool-name list (no args)
  - Cost: no extra gate; save_eval_set caps rubric at ~5 criteria per case
  - Errors: one strict-JSON retry, then judge-error marker on the criterion
    (case verdict unaffected; card shows warning)
  - Meta-eval: mocked unit tests (MockLanguageModelV3) for plumbing + small
    live fixture suite vs the real pinned judge behind LIVE_JUDGE=1
  - Touches: EVAL_EXPECTED, grade/run/store, EvalRunCard (judge reasons shown
    distinctly), builder EVALS prompt + eval-author (AUTHOR drafts rubric;
    DIAGNOSE gains fixTarget:"rubric")

Original context: /tmp/handoff-eval-grader-tiers.md

### Review (2026-07-22)

Shipped all three grader tiers in commits eedde18 (eval-author + review fixes),
5336e7d (trajectory checks), e08a75e (repeats), a674ffd (judge) on PR #6.
CodeRabbit had already APPROVED the branch before today's pushes.

Verification: 41 vitest + 3 live-gated green, tsc + eslint clean per commit;
judge meta-eval 3/3 against the REAL pinned Haiku (LIVE_JUDGE=1). Live browser
run (fresh builder chat, restarted dev server): edited the nutrition set via
the builder (rubric + repeats:2 on nutrition-mid-race-fueling, ids stable),
approved save + run → live card counted attempts 0/6 → final 5/5 · ±0 with a
"2/2 runs" chip → expanded row shows the Judge section with the criterion and
the judge's reasoning → DB row has judge_model_id=claude-haiku-4-5 and the
per-attempt fields persisted.

Open product question (from the pre-commit review): eval-author appears in the
user-facing agent picker; its instructions handle direct chats, but if it
should be hidden an internal-only flag on AgentMeta is the likely shape.
- [ ] 4. (later) Multi-turn cases — wait for a real multi-turn failure
builder briefed eval-author via spawn_agent ("Delegated to eval-author" thread in
UI) → strict-JSON cases came back with REAL tool names (runner-kn_orient, self-
discovered via get_agent) → curation table → approved save_eval_set → run_evals
live card 4/5 → builder auto-delegated diagnosis to the SAME eval-author thread
(DB: one sub_ chat, 6 messages across author + 2 diagnose rounds) → get_eval_run
+ read_transcript used live → verdict fixTarget:"case" (false-positive "I can't")
applied + saved → re-run → 3/5 (real agent bug: web_fetch instead of orient) →
verdict fixTarget:"agent" → builder proposed save_agent instruction fix (left
pending for the user). 25 vitest tests green, tsc green.
