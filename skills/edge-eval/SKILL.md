---
name: edge-eval
description: Run, judge, review and report the Edge ablation benchmark (Edge Eval v0) in apps/latch-platform — set up connections and arms, run a sweep, judge it, send blinded pairs to human reviewers, and produce the HTML bench. Use whenever someone wants to measure Edge, compare its arms (A/A′/B/C/D), re-run the benchmark after a prompt change, check a judge's reliability, or asks "how good is Edge".
---

# Edge Eval — run the benchmark

Edge (`edge-v2`) is an AI-strategy advisor that combines IF's playbooks (the **vertical**
plane, `edge-v2-kn`) with one client's own situation (the **horizontal** plane,
`edge-client`). This benchmark measures whether that combination beats a good generic model,
by asking the same questions several ways and scoring the answers.

**You do not need to understand the code to run this.** Follow the golden path. Every
command is copy-pasteable and safe: the sweep never writes to a real workspace, and nothing
here deletes anything.

---

## First-time setup on a machine

Skip to the golden path if `pnpm edge:setup` already reports all ✓.

1. **Repo and dependencies** — `pnpm install` at the repo root.
2. **`apps/latch-platform/.env`** — ask whoever set this up for the file, or copy it from
   another checkout. What the eval needs from it:

   | Variable | Why |
   |---|---|
   | `DATABASE_URL` | the local SQLite database (e.g. `file:./latch.db`) |
   | `LATCH_VAULT_KEY` | connection records are encrypted with it |
   | `OPENAI_API_KEY` | the arms run on `gpt-5.6-sol` |
   | `ANTHROPIC_API_KEY` | the judge and A′'s card writer are Claude models |
   | `LOREDEX_EVAL_WS_ID`, `LOREDEX_EVAL_API_KEY` | fingerprinting the client plane — GET only, a **read-only key is enough** |
   | `EDGE_EVAL_USER_EMAIL` | optional; defaults to the repo owner's address |

3. **The dev server and a user account** — `cd apps/latch-platform && pnpm dev`, then sign in
   at `http://localhost:3000` as `EDGE_EVAL_USER_EMAIL`. That user owns the connections and
   the arm agents. **Only one dev server may run against a given `latch.db`**: a second one
   (typically another checkout) holds a write lock and fails every cell instantly.
4. **`pnpm edge:setup`** — creates the connection records and the five arm agents, checks
   everything else, and prints what still needs a human.
5. **One Connect click per connection** — setup will report `edge-client`, `edge-v2-kn` and
   `edge-v2-inbox` as not authorized. Open `http://localhost:3000/connections` and press
   Connect on each (the Loredex token is user-wide, so one sign-in covers all three). Run
   `pnpm edge:setup` again; it should be all ✓.
6. **Langfuse — only for the human review step.** Needs Docker:
   `cd tools/langfuse-local && docker compose up -d && bash setup-reviewers.sh` (web on
   :3100; the script writes `apps/latch-platform/.env.langfuse-local`). Do not upgrade the
   stack to v4 — it is pinned to v3 images because v4 breaks the reads this repo uses.

## Golden path (what to do 95% of the time)

Everything runs from `apps/latch-platform`.

```bash
cd apps/latch-platform

# 0. Is the machine ready? Creates what it can, tells you what needs a human.
pnpm edge:setup

# 1. Run a sweep (start small: 3 cases × 5 arms ≈ 6 min, a few dollars)
pnpm edge:run --name my-run --variants A,AP,B,C,D --cases INFRA-01,AX-01,CODE-05 --reps 1 --concurrency 3

# 2. Score it (one Claude call per rubric dimension per cell)
pnpm edge:judge --run my-run

# 3. Look at it — a self-contained HTML page
pnpm edge:report --run my-run
open edge-eval-runs/my-run/report.html
```

Every `pnpm edge:*` script is the plain `node --env-file=.env --env-file=.env.langfuse-local
--import tsx src/scripts/edge-<x>.ts` command with the env files already attached; use the
long form if you prefer it.

If step 0 reports anything with `✗`, do exactly what it says and run it again. The most
common one is a connection that needs one **Connect** click at
`http://localhost:3000/connections` (the local dev server must be running: `pnpm dev`).

---

## What the numbers mean

| Term | Meaning |
|---|---|
| **Arm** | One configuration of the advisor. `A` prompt only · `A′` (`AP`) prompt + a written client card · `B` client plane only · `C` knowledge plane only · `D` the full Edge |
| **Case** | One test question (68 exist; 30 are sealed as the benchmark set, 10 of those are a holdout) |
| **Cell** | One (case × arm × repetition) — two turns: the question, then a canned follow-up. The follow-up answer is what gets scored |
| **Composite** | The four 0–3 judge dimensions summed → 0–12 |
| **Hard failure** | An automatic fail: an invented client fact, an invented house stance, wrong maturity stage, no recommendation, a leaked file path… |
| **D − A′** | The headline: how far the full product is ahead of the same model handed a paragraph about the client. This is the comparison an outsider would make |
| **D − B / D − C** | Which plane is carrying the result — the internal diagnostics |

`A′` exists because `D − A` is not a fair fight: `A` cannot know the client at all. `A′` is
given a fixed 5–6 sentence card about the client, built once per sweep from the live client
plane and pasted in front of every question, exactly as someone would brief ChatGPT.

---

## The commands, in full

All of them take `--run <name>` or `--name <name>` and read/write
`apps/latch-platform/edge-eval-runs/<name>/` (git-ignored).

| Command | What it does |
|---|---|
| `pnpm edge:setup` | The readiness check. Creates connection records and the five arm agents; reports what needs a human. `--check` = report only |
| `pnpm edge:run` | The sweep. `--variants A,AP,B,C,D --cases <ids\|all\|optimization\|holdout\|client-team> --reps N --concurrency 3 [--resume] [--dry-run]` |
| `pnpm edge:judge` | Scores every cell on nine rubric dimensions. `[--judge-model claude-sonnet-5] [--dims …] [--out <file>] [--redo-errors] [--force]` |
| `pnpm edge:report` | The HTML bench for the run. `[--no-background]` skips the live "what the answers are grounded against" section |
| `pnpm edge:review:export` | Sends blinded D-vs-A pairs to the human reviewers' Langfuse queues |
| `pnpm edge:judge:pairwise` | Has the judge answer the reviewers' question on the same blinded pairs (for judge-vs-human agreement). `[--anchors-only] [--judge-model …] [--out <file>]` |
| `pnpm edge:review:import` | Reads the reviewers' annotations back, unblinds them, and reports judge-vs-human agreement (κ) |
| `pnpm edge:reliability` | The judge's noise floor: self-consistency and a second model family |
| `pnpm edge:snapshot` / `pnpm edge:snapshot:kn` | Re-fingerprint a context plane after it legitimately changed (`--verify` to just check) |
| `pnpm edge:version` | Rewrites `src/evals/edge/v0/version.json` (prompt hashes, plane hashes, git sha) — run after a prompt edit |
| `node … src/scripts/edge-select.ts` | Re-runs the sealed case selection (only for a new benchmark generation) |

### Sizing a sweep

One cell ≈ two model calls ≈ $0.30 on `gpt-5.6-sol`, ~40 s. Judging adds ~$0.08/cell.
`--concurrency 3` is the safe default; **4 is the ceiling** — the local SQLite database
starts throwing `SQLITE_BUSY` above it. The full benchmark (30 cases × 5 arms × 3 reps) is
450 cells, roughly $150 and several hours, and needs the owner's explicit go-ahead.

A sweep that dies mid-way is resumed, never restarted: same `--name`, add `--resume`.

---

## Getting humans into the loop

Three reviewers score blinded pairs in a **local** Langfuse (nothing leaves the machine).

```bash
cd ../../tools/langfuse-local && docker compose up -d && bash setup-reviewers.sh && cd ../../apps/latch-platform
pnpm edge:review:export --run my-run
# reviewers log in at http://localhost:3100 → Annotation queues, and score each pair
pnpm edge:review:import --run my-run
```

Each reviewer gets their own queue (an item can only be completed once, so a shared queue
would let the first reviewer close it for everyone). A shared *anchor* set goes to all three
so their agreement with each other can be measured.

**Never upload the un-blinded mapping.** Which arm is Left and which is Right lives only in
`edge-eval-runs/<run>/review/pairs.json` on the machine.

## Checking the instrument before trusting it

```bash
# same judge, second pass over the same cells → its own noise floor
pnpm edge:judge --run my-run --out judgments-pass2.jsonl
# a second model family on the pairs
pnpm edge:judge:pairwise --run my-run --anchors-only --judge-model claude-opus-5 --out judgments-pairwise-opus.jsonl
pnpm edge:reliability --run my-run --b judgments-pass2.jsonl --pair-b review/judgments-pairwise-opus.jsonl
```

A difference between two prompt versions that is smaller than the judge's own noise floor is
not a result. Both numbers appear in the report.

---

## Rules that are not negotiable

1. **The `edge-client` workspace is a real client's and is eval material as it is.** Never
   create, edit or delete anything in it, and never copy its content into the repo. The
   agents' writes are approval-gated and stubbed inert by the runner; the sweep hashes the
   plane before and after and fails if it changed.
2. **`edge-base` (the knowledge plane) is read-only** through its scoped endpoint, and hashed
   the same way.
3. **Only the plane owners change a plane.** If a hash mismatch is reported, that is
   information (a new cohort), not something to "fix" by re-snapshotting without asking.
4. **A big sweep costs real money.** Anything beyond a handful of cases needs the owner's
   explicit go-ahead, with the estimate stated first.
5. **The sealed case sets** (`cases/holdout.json`, `cases/selection.json`) are not edited to
   make a number look better.

## When something goes wrong

| Symptom | Cause and fix |
|---|---|
| Every cell fails instantly with `Failed query: insert into latch_chats` | Another app holds a write lock on the local database. `lsof latch.db` finds it; stop it (usually a dev server from another checkout) |
| Scattered `SQLITE_BUSY` failures | Concurrency too high. Re-run with `--resume --concurrency 3` |
| `model "…" resolved to "…" — catalog fallback` | The model id is unknown to the catalog and would have silently swapped the model. Check the id and the provider key |
| `connection … is not authorized` | One Connect click at `http://localhost:3000/connections` (dev server must be running) |
| `client plane drifted` / `knowledge plane drifted` | The workspace genuinely changed. Ask the owner; if it is expected, re-run the matching snapshot script, and treat results before and after as different cohorts |
| A judged dimension shows `ERR` | A schema miss, not a verdict. `--redo-errors` re-judges only those |
| Langfuse reads fail after an upgrade | The local stack is pinned to v3 images on purpose; v4 breaks the reads this repo uses. Do not upgrade it |
| The report page is blank | The generated page script failed to parse. `edge-report.ts` parse-checks it now — re-run it and read the error |

## Where things live

```
apps/latch-platform/
  src/evals/edge/
    prompt/edge-v2.prompt.md   one tagged prompt; the arms are a selection over its blocks
    variants.ts                the arms (connections, approval map, agent records)
    cases/                     the 68 questions, the sealed sets, the 30 case contracts
    judge/                     the rubric, the pairwise dimension, agreement maths
    client-card.ts             A′'s client card
    v0/version.json            what a result is attributable to (prompt + plane hashes)
  src/scripts/edge-*.ts        every command in the table above
  edge-eval-runs/<name>/       results (git-ignored): cells.jsonl, judgments.jsonl, report.html
tools/langfuse-local/          the local Langfuse for human review
```

## Reporting back

When a run finishes, tell the person: the arm means and **D − A′**, how many cases D actually
won, the hard failures by kind, whether both plane hashes were unchanged, what it cost — and
whether the difference is bigger than the judge's noise floor. Link the report file. If the
judge has not been calibrated against humans for this generation, say so.
