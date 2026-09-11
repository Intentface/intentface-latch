# Edge Eval v0

The ablation benchmark for Edge (`edge-v2`): the same question asked five ways, scored
against each other, so a prompt change can be shown to have moved something.

**To run it, read [`skills/edge-eval/SKILL.md`](../../../../skills/edge-eval/SKILL.md)** — the
runbook, written so that Claude (or a person following it literally) can do the whole loop.
The short version, from `apps/latch-platform`:

```bash
pnpm edge:setup                                                    # what is ready, what needs a human
pnpm edge:run --name my-run --variants A,AP,B,C,D --cases INFRA-01,AX-01,CODE-05
pnpm edge:judge --run my-run
pnpm edge:report --run my-run
```

## What is in here

| Path | What it holds |
|---|---|
| `prompt/edge-v2.prompt.md` | ONE prompt, its segments tagged `<!-- @@ TAG -->`. The arms are a selection over those segments — never five hand-maintained prompts |
| `prompt/compose.ts` | The composer + `prompt:<sha8>`, the cohort key of a prompt version |
| `variants.ts` | The arms: A, A′ (`AP`), B, C, D — connections, the production approval map, the agent records the runner upserts |
| `client-card.ts` | A′'s client card: the fixed paragraph about the client that turns arm A into a fair outside baseline |
| `cases/` | The 68 questions, the sealed holdout and selection, the 30 case contracts, the canned follow-up |
| `judge/rubric.ts` | Judge v0: nine dimensions, one evaluator each |
| `judge/pairwise.ts` | The one question humans and judge both answer on a blinded pair |
| `judge/agreement.ts` | κ and raw agreement — judge vs itself, judge vs judge, judge vs human |
| `judge/reference.ts` | Reads the live planes (both judges and the report share this) |
| `fixtures/*/manifest.json` | Content fingerprints of the two context planes. Hashes only — **no plane content is ever committed** |
| `v0/` | The frozen baseline: the captured production record and instructions, and `version.json` — what a result is attributable to |

Results live in `apps/latch-platform/edge-eval-runs/<name>/` and are git-ignored.

## The two rules

1. The live workspaces behind the planes (`edge-client`, `edge-base`) are read-only material.
   Nothing here writes to them; the runner hashes both before and after a sweep and fails if
   either changed.
2. No plane content in git. Fingerprints and file names only.
