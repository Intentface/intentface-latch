---
name: edge-eval
description: Run, judge, review and report the Edge ablation benchmark (Edge Eval v0) in apps/latch-platform — set up connections and arms, run a sweep, judge it, send blinded pairs to human reviewers, and produce the HTML bench. Use whenever someone wants to measure Edge, compare its arms (A/A′/B/C/D), re-run the benchmark after a prompt change, check a judge's reliability, or asks "how good is Edge".
---

# Edge Eval — run the benchmark

Edge (`edge-v2`) is an AI-strategy advisor that combines IF's playbooks (the **vertical**
plane, `edge-v2-kn`) with one client's own situation (the **horizontal** plane,
`edge-client`). This benchmark measures whether that combination beats a good generic model,
by asking the same questions several ways and scoring the answers.

**You do not need to understand the code to run this.** Run `pnpm edge`. Every command here
is copy-pasteable and safe: the sweep never writes to a real workspace, and nothing here
deletes anything.

---

## Run it

```bash
pnpm edge
```

From the repo root, or from `apps/latch-platform` — either works. That one command builds the
workspace packages, writes `.env` from `.env.example` if it is missing, creates the local
database schema, checks the machine, states what a sweep will cost and asks before spending
it, runs the sweep, judges it and renders the HTML bench. It echoes every command it runs, so
you end up knowing the long form rather than depending on the wrapper.

It never spends money without a `y`, and never decides for you that a drifted context plane
is still the same cohort.

### The two things it cannot do for you

On a machine that has never run this, `pnpm edge` stops twice and tells you exactly what to
do. Both are one-time.

1. **Paste the secrets.** It creates `apps/latch-platform/.env` and lists the values it
   cannot invent: `LATCH_VAULT_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
   `LOREDEX_EVAL_WS_ID`, `LOREDEX_EVAL_API_KEY` (a **read-only** key — the eval only ever
   GETs the client workspace) and `BETTER_AUTH_SECRET`, which you generate yourself with the
   command it prints. Ask whoever runs the benchmark for the rest. `DATABASE_URL` can stay
   `file:./latch.db`.

2. **One sign-up and three Connect clicks.** The Loredex MCP endpoints only accept
   interactive OAuth — a script cannot authorize them (the REST key that fingerprints the
   plane is rejected by `/mcp` with `invalid_token`), so this part is genuinely human:

   ```bash
   cd apps/latch-platform && pnpm dev          # in its own terminal
   ```

   Sign up at `http://localhost:3000/login` as `EDGE_EVAL_USER_EMAIL` (any password — the
   account lives only in your own `latch.db`; sign-in is restricted to `@intentface.com`),
   then press **Connect** on `edge-client`, `edge-v2-kn` and `edge-v2-inbox` at
   `http://localhost:3000/connections`. One Loredex sign-in covers all three.

   **Everyone runs as themselves.** `EDGE_EVAL_USER_EMAIL` is your own address, the local
   account is yours, and the three grants come from your own Loredex sign-in — so your
   Loredex account needs read access to both workspaces. Nobody borrows anyone's account,
   and the only thing that travels between machines is the secrets in `.env`.

   If :3000 is already served by **another checkout**, `pnpm edge` says so with the path and
   pid: clicks there authorize that checkout's database, not yours.

Run `pnpm edge` again and it goes all the way through.

### Doing the steps yourself

`pnpm edge` is only a wrapper over four commands. Any of them can be run on its own:

```bash
cd apps/latch-platform

pnpm edge:setup    # readiness — creates what it can, prints what needs a human
pnpm edge:run --name my-run --variants A,AP,B,C,D --cases INFRA-01,AX-01,CODE-05 --reps 1 --concurrency 3
pnpm edge:judge --run my-run
pnpm edge:report --run my-run     # → edge-eval-runs/my-run/report.html
```

`pnpm edge` takes the same arguments as the sweep: `pnpm edge --name nightly --cases all --reps 3 --yes`.

Every `pnpm edge:*` script is the plain `node --env-file=.env --env-file=.env.langfuse-local
--import tsx src/scripts/edge-<x>.ts` command with the env files already attached; use the
long form if you prefer it.

**Langfuse is only for the human review step**, and needs Docker:
`cd tools/langfuse-local && docker compose up -d && bash setup-reviewers.sh` (web on :3100;
the script writes `apps/latch-platform/.env.langfuse-local`). Do not upgrade the stack to v4
— it is pinned to v3 images because v4 breaks the reads this repo uses.

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
| `pnpm edge` | All four steps below in order, with a `y/N` before the one that costs money. Takes the sweep's arguments (`--name`, `--cases`, `--reps`, `--variants`, `--yes`) |
| `pnpm edge:setup` | The readiness check. Creates connection records and the five arm agents; reports what needs a human. `--check` = report only |
| `pnpm edge:run` | The sweep. `--variants A,AP,B,C,D --cases <ids\|all\|optimization\|holdout\|client-team> --reps N --concurrency 3 [--resume] [--dry-run] [--model <id>]` |
| `pnpm edge:judge` | Scores every cell on nine rubric dimensions. `[--judge-model claude-sonnet-5] [--dims …] [--out <file>] [--redo-errors] [--force]` |
| `pnpm edge:report` | The HTML bench for the run. `[--no-background]` skips the live "what the answers are grounded against" section |
| `pnpm edge:review:export` | Sends blinded D-vs-A pairs to the human reviewers' Langfuse queues |
| `pnpm edge:judge:pairwise` | Has the judge answer the reviewers' question on the same blinded pairs (for judge-vs-human agreement). `[--anchors-only] [--judge-model …] [--out <file>]` |
| `pnpm edge:review:import` | Reads the reviewers' annotations back, unblinds them, and reports judge-vs-human agreement (κ) |
| `pnpm edge:reliability` | The judge's noise floor: self-consistency and a second model family |
| `pnpm edge:snapshot` / `pnpm edge:snapshot:kn` | Re-fingerprint a context plane after it legitimately changed (`--verify` to just check) |
| `pnpm edge:version` | Rewrites `src/evals/edge/v0/version.json` (prompt hashes, plane hashes, git sha) — run after a prompt edit |
| `node … src/scripts/edge-select.ts` | Re-runs the sealed case selection (only for a new benchmark generation) |

### Trying the pipeline without paying benchmark prices

```bash
pnpm edge --model gpt-5.6-luna --name pipeline-check
```

`--model` swaps the model in every arm (`pnpm edge` passes it through to the sweep). Use it to
prove a fresh machine works end to end — connections, cells, judging, report — for a fraction
of the cost.

**What comes back is not a benchmark result.** `gpt-5.6-luna` is the cheap sibling the case
*selection* pilot ran on, deliberately not the thing being measured: `v0/version.json` pins
the benchmark to `gpt-5.6-sol`, and every published D − A′ is that model. A run on anything
else records its own `model` in the summary and in the report's header, so it can never be
mistaken for one — but do not compare its numbers with v0's, and do not put them in front of
anyone as "how good Edge is".

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
6. **The benchmark model is part of the generation, not a runtime choice.** `--model` exists
   for pilots and pipeline checks; a v0 result means `gpt-5.6-sol`. Changing what v0 runs on
   means re-cutting `v0/version.json` (`pnpm edge:version`) and treating everything before it
   as a different generation.

## When something goes wrong

| Symptom | Cause and fix |
|---|---|
| `ERR_MODULE_NOT_FOUND … /dist/index.js` | The workspace packages are not built. `pnpm edge` does it for you; by hand it is `pnpm install && pnpm build` at the repo root |
| Connect clicks never take effect — setup keeps saying "not authorized" | :3000 is served by a *different* checkout, so the grant landed in that checkout's database. `pnpm edge:setup` now names the path and pid; stop it and run `pnpm dev` in this one |
| Every cell fails instantly with `Failed query: insert into latch_chats` | Another app holds a write lock on the local database. `lsof latch.db` finds it; stop it (usually a dev server from another checkout) |
| Scattered `SQLITE_BUSY` failures | Concurrency too high. Re-run with `--resume --concurrency 3` |
| `model "…" resolved to "…" — catalog fallback` | The model id is unknown to the catalog and would have silently swapped the model. Check the id and the provider key |
| `connection … is not authorized` | One Connect click at `http://localhost:3000/connections` (dev server must be running) |
| `client plane drifted` / `knowledge plane drifted` | The workspace genuinely changed — the error lists which files, `~ edge/memory/notes.md (content changed, v2 → v4)`. Ask the owner; if it is expected, run with `--allow-drift` and treat results before and after as different cohorts. Only the plane owner re-snapshots |
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
  scripts/edge-preflight.mjs   build + .env + schema, before any eval script is imported
  src/scripts/edge-go.ts       `pnpm edge` — the four steps in order
  src/scripts/edge-*.ts        every command in the table above
  edge-eval-runs/<name>/       results (git-ignored): cells.jsonl, judgments.jsonl, report.html
tools/langfuse-local/          the local Langfuse for human review
```

## Reporting back

When a run finishes, tell the person: the arm means and **D − A′**, how many cases D actually
won, the hard failures by kind, whether both plane hashes were unchanged, what it cost — and
whether the difference is bigger than the judge's noise floor. Link the report file. If the
judge has not been calibrated against humans for this generation, say so.
