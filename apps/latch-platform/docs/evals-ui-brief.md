# Evals UI — design brief

The `/evals` page works and is ugly. It was built function-first by someone who
could not see it render. This brief is for a designer to make it usable.

**Read this whole file before touching anything.** The domain is unusual and the
mistakes are not the obvious ones.

---

## 1. What this page is for

An agent is a program whose behaviour you cannot diff. The page exists to answer
three questions, in this order of how often they are asked:

1. **Is my agent doing what it promises?** (most of the time)
2. **Did my change break something?** (before a release)
3. **Can I trust this measurement?** (the first time someone doubts a red mark)

Everything on the page serves one of those. If a control serves none of them,
it should not be there.

## 2. The domain model, in five terms

Learn these. The UI currently uses them inconsistently, which is part of the
problem.

| Term | What it is |
|---|---|
| **Case** | One conversation to send the agent: a first message plus optional follow-up turns. |
| **Check** | One *judged question* asked about what happened. Three kinds — see below. |
| **Exact check** | A deterministic comparison (was this tool called, with these args). Free, cannot be wrong. |
| **Run** | One execution of a whole set of cases against one *configuration* of the agent. |
| **Verdict** | One check's answer for one case in one run. May carry a human's ruling beside the judge's. |

### The three check kinds — this distinction is the product

- **boolean** — a real line. "Is every claim supported by a document it opened?"
- **choice** — a failure with several *shapes*. "The question was ambiguous. What
  did the agent do?" → `asked` / `said_so` / `guessed` / `refused`, with only
  some marked as failures.
- **score** — a matter of degree, with named rungs worst→best.

A choice verdict's **selected option is the diagnosis**. `said_none_match` and
`invented_posts` are both "fail" to a boolean and completely different bugs. The
UI must never reduce a choice to a tick. It currently shows the option label in
the grid — keep that, make it legible.

### Configurations

A run is pinned to one of: `live`, a published version (`v7`), or the author's
unpublished `draft`. Runs are labelled by this, not by time — two runs of the
same version are a *flakiness* signal; two runs of different versions are a
*comparison*. A timestamp alone cannot tell you which you are looking at.

---

## 3. The priority feature: show the evidence

**This is the main ask and everything else is secondary.**

Today a verdict is a coloured mark with a tooltip. To decide whether the judge
was *right* you must read the actual conversation, and there is no way to. That
makes the correction buttons ("should pass" / "should fail") close to useless,
because you would be ruling blind.

Design an **evidence view**: from any verdict, see the conversation that
produced it.

It must show, in this order:

1. **The user turns**, including follow-ups, clearly separated.
2. **Every tool call with its ARGUMENTS and its RESULT.** Not just the tool name.
   Half the checks are about whether an answer came from a tool result, so
   hiding the result makes them unjudgeable.
3. **The agent's replies.**
4. **The judge's verdict for each check**, with its confidence, and the ruling
   buttons in reach.

Three traps, all real:

- **Tool results are long.** They need to be collapsible, but the collapsed
  state must say how much is hidden. A judge that read 2,000 characters and a
  reader who sees 200 do not have the same evidence.
- **Truncation must be visible.** The backend marks cut content with
  `…[truncated]`. Do not style that away.
- **The judge may not have seen the whole conversation.** Long runs are cut into
  overlapping windows and each is judged separately. Showing the full transcript
  next to a verdict drawn from window 3 is actively misleading. A verdict now
  carries `slices` (how many windows) and `failedSlices` (which ones failed) —
  when `slices > 1`, say so, and treat "which window" as evidence the reader
  needs.

**The data is ready.** `getEvalTranscriptFn({ threadId })` returns the whole
conversation — every message, every tool call with its `args` and `result`,
already generously capped (12k chars of text, 8k per tool result) and marked
where cut. Every case result carries the `threadId` that produced it.

`@intentface/chat` is already a dependency and unused here. Its `Steps`
primitive is a collapsible reasoning/tool timeline and `Message` is a role-aware
container — they exist for exactly this. Evaluate them before hand-rolling.

---

## 4. The rest, in priority order

### 4.1 The page has no shape

Four stacked panels of near-identical weight before you reach anything:
audit, generate, toolbar, cases. A first-time visitor cannot tell what to do
first. Decide what the primary action is and make everything else quieter.

For reference, the intended flow:
**audit** (zero setup, one click, gives the first number) → **generate** cases
from a description → **edit** → **run** against a configuration → **read
results** → **rule on verdicts you doubt**.

### 4.2 The check editor is dense

Each check is: id, kind, question, plus kind-specific fields (options as
`name: meaning` lines with failure checkboxes, or score rungs with a "fails at
or below" selector). It is correct and unpleasant. Note that **what is edited
here is exactly the object the judge receives** — there is no translation layer,
so the shape cannot be simplified away, only presented better.

### 4.3 The results grid

Checks down the side, runs across the top. Rows whose verdict changed between
runs sort to the top and are badged. Three cell states that must look different:

- **passed / failed** — the verdict
- **`·` not applicable** — the check did not exist when that run happened
- *(missing, should exist)* — **judged but uncertain**: a verdict at 0.51 is
  currently drawn identically to one at 0.99. Consider a third state for
  low-confidence answers. These are also the best candidates for human ruling,
  so uncertainty and the correction flow belong together.

### 4.4 The comparison strip

Per check: the difference between two runs, drawn as an interval on a track
centred on zero, with the point estimate as a tick. Crossing zero is the whole
message — it means *we cannot tell*.

It will usually say `UNDERPOWERED`, and **that is correct, not a bug to design
around**. A handful of cases cannot separate a real change from noise. Do not
make the interval look more confident than it is; if anything, make crossing
zero more obvious.

### 4.5 Reliability

Per question: how often the judge agreed with a human, and whether it has earned
the right to fail a build. Two states: **reports only** and **can gate**. A
question nobody has ruled on does not appear at all — silence is not evidence.

---

## 5. Constraints

- **Use the existing token system.** `--color-ink-primary/secondary/tertiary`,
  `--color-secondary-border`, `--color-accent-*`, `--color-destructive`, and the
  rest in `src/styles.css` (OKLCH). **Do not introduce new colours.** Semantic
  pass/fail colour is separate from the accent hue.
- Existing UI components live in `src/components/ui/`. Prefer them.
- Tailwind v4. Existing pages to match: `src/routes/observability.tsx`,
  `src/routes/schedules.tsx`.
- This page is dense and data-heavy. It is a **tool**, not a landing page:
  scanned and operated, not read top to bottom. Encode state in form as well as
  colour so it survives a screenshot and a colourblind reader.
- Must work at ~1280px. It is an internal tool; phone width is not a
  requirement, but nothing should scroll sideways except the grid.

## 6. Where the code is

| What | Path |
|---|---|
| The page (everything below is in this one file — splitting it is welcome) | `src/routes/evals.tsx` |
| Server functions | `src/lib/server.ts` — search `Eval sets:` |
| Check / question types | `src/lib/evals/ask.ts` |
| Case, run, verdict types | `src/lib/evals/store.ts` |
| Reliability rules | `src/lib/evals/reliability.ts` |
| Comparison statistics | `src/lib/evals/stats.ts` |
| Design tokens | `src/styles.css` |

`pnpm dev` from `apps/latch-platform`, then `localhost:3000/evals`. There is
real seeded data on the `hn-digest` agent: three cases, several runs, boolean
and choice checks, and one conversation that fails a check.

## 7. Docs to read

- **`@intentface/chat` primitives** — <https://intentface-chat.vercel.app/llms.txt>
  (every page also available as `.md`). Specifically `Steps`, `Message`,
  `Reasoning`, `Chip`.
- **The evaluation contract the checks map onto** —
  <https://ai-sdk.dev/docs/ai-sdk-core/evaluation>. Read this to understand why
  there are exactly three kinds of check and why a choice is not a styled
  boolean.
- **TypeSafe AI** (the default judge) — <https://docs.typesafe.ai/introduction>.
  Skim only; it explains why answers carry probabilities.

## 8. Explicitly out of scope

- Changing what a check *is*. The three kinds are the contract, not a UI choice.
- Making `UNDERPOWERED` look decisive.
- Reducing a choice verdict to pass/fail anywhere.
- New colours, new icon sets, a dashboard of big-number tiles.

## 9. How to know it worked

A person who has never seen the page should be able to:

1. Get a first number about their agent without typing anything.
2. Look at a red mark and, within two clicks, read the conversation that caused
   it and decide whether the judge was right.
3. Tell at a glance which rows changed between two runs.
4. Understand that `UNDERPOWERED` means "not enough data", not "broken".
