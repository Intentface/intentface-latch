# The Anchor / Edge knowledge pipeline

How expert knowledge moves from a person's head to a client-facing advisor, agent by
agent and workspace by workspace. Source of truth: the agent files under
`apps/latch-platform/src/agents/` (this doc is the gist; the header comments there
carry the full contracts).

## The mental model

A **knowledge refinery with two sides**. The *anchor* side extracts and distills
expert knowledge; the *edge* side serves it to clients. One agent — the maintainer —
is the deliberate chokepoint between them. Everything runs across Loredex workspaces
(MCP connections, bound by name), and **write-asymmetry is the security model**: who
may read vs. write which workspace is what enforces the contracts, ahead of any
prompt rule.

## Workspaces

| Connection | Holds | Written by |
|---|---|---|
| `anchor-frame` | `anchor/domain.md` (the human-owned map), `anchor/sources/*`, coverage digests | humans (map, sources) · frame-keeper (coverage, proposals) |
| `anchor-build` | `anchor/interviews/*`, `anchor/sessions/*`, changelog, review queue | interview agents · anchor-session · maintainer (bookkeeping) |
| `client-work-anchor-frame` / `-build` | a structurally identical second plane (same internal paths, different workspace) | as above |
| `orient-profiles` | `profiles/<name>.md` — per-interviewee profiles | anchor-orient only |
| `company-loredex` | org's shared knowledge (optional enrichment source) | not this pipeline |
| `edge-kn` | `edge/kn/<pillar>/playbook.md` (the served playbooks), `edge/examples/catalog.md`, `edge/assessment/` | maintainer (playbooks) · humans (catalog, rubrics) |
| `edge-onboarding` | onboarding arc + placement rubrics (template) | humans |
| `edge-client` (per client) | `edge/ctx/*`, `edge/ctx/placement.md`, `edge/memory/` | edge-onboarding · edge-advisor |
| `edge-inbox` | anonymized knowledge-gap notes | edge-advisor |

## The flow

1. **Seed (human).** Someone writes `anchor/domain.md` into the frame — the field,
   the map of areas, the completeness bar per area. No agent may edit the map; agents
   only file proposals (`anchor/domain-proposals.md`).

2. **Orient.** An expert opens a chat with `anchor-interview`. Before its first
   visible message it spawns **`anchor-orient`** (batch subagent), which reads the
   frame, *lists* the build plane (file names + headers only), optionally searches
   `company-loredex`, updates `profiles/<name>.md`, and returns one briefing:
   `## Domain / ## Coverage / ## Sources / ## Interviewee`. Everything it passes on
   is coverage-level metadata — "if in doubt whether a detail is coverage or
   content: it is content."

3. **Extract.** **`anchor-interview`** (stage 1) sweeps the map (one opener per
   active area, then deepen; incident-anchored; catch-all last) and writes exactly
   one file `anchor/interviews/<name>_<date>_s<n>` — a list of discrete practices
   (`Area / Practice / Addresses / Evidence`). It never reads the build plane: prior
   conclusions would contaminate a baseline extraction. If the save fails it must
   say so and dump the contribution inline — never claim a phantom save.

4. **Fold back coverage.** The scheduled **`anchor-frame-keeper`** diffs the build's
   listing against each coverage note's own `## Folded files` list and writes
   `anchor/sources/coverage_<name>.md` — one `COVERED | THIN | UNTOUCHED` line per
   map area, statuses never downgraded. **This closes the interview loop**: without
   it, orient has no coverage data and every session behaves as session 1.

5. **Merge (the chokepoint).** **`anchor-maintainer`** (stage 3) classifies every
   unprocessed interview/session against the *actual* playbook text (distrusting
   self-labels), then pushes candidates through five ordered gates —
   **Safety → Dedup → Evidence (≥2 contributions or one strong first-hand account)
   → Conflict (never merged, always queued for a human) → Redaction (client
   identifiers generalized away)**. Survivors land in
   `edge/kn/<pillar>/playbook.md`; changelog + `anchor/review-queue.md` go back to
   the build plane. This is the only point where knowledge crosses from the private
   anchor side to the client-served side.

6. **Enrich.** **`anchor-session`** (stage 2) runs a light ~10-question A–E check-in
   verifying the served playbook against one person's current reality, saving
   `anchor/sessions/<name>_<date>` with `Confirms / Extends / Diverges / Gap`
   (when torn, Extends — an unsupported Confirms makes the maintainer dedup-discard
   genuinely new knowledge). Sessions feed both the frame-keeper and the next
   maintainer run.

7. **Client side.** **`edge-onboarding`** interviews a client team using the
   template's arc + rubrics and writes the client context plane — `edge/ctx/*` plus
   `edge/ctx/placement.md` (maturity rung per dimension, evidence, confidence) —
   into that client's own workspace. Rubric labels are never read to the client.

8. **Serve.** **`edge-advisor`** ("THE product") reads `edge-kn` (read-only by
   design — the binding has no write tools) and the client workspace (placement
   first), answers calibrated to the client's rung ("never prescribe the ceiling,
   never re-prescribe the floor"), logs every substantive recommendation to
   `edge/memory/` in the same turn, and drops anonymized gap notes into
   `edge-inbox`. Every named specific must trace to a file read in this
   conversation.

## Agents at a glance

| Agent | Stage | Reads | Writes | Trigger |
|---|---|---|---|---|
| `anchor-orient` | 0 | frame · build (names/headers) · profiles · company | `orient-profiles` | spawned by interviews |
| `anchor-interview` | 1 | briefing (frame as fallback) | one `anchor/interviews/…` file | chat |
| `client-work-interview` | 1 | same, client-work plane | same, client-work plane | chat |
| `anchor-interview-mem` | 1 | briefing + injected memory | interviews file + (via sweep) memory levels | chat |
| `anchor-session` | 2 | frame · edge-kn playbook · own priors | one `anchor/sessions/…` file | recurring chat |
| `anchor-frame-keeper` | 2.5 | frame + build (both planes) | coverage digests, domain proposals | schedule |
| `anchor-maintainer` | 3 | frame · build · edge-kn | playbook (edge-kn) · changelog/queue (build) | schedule |
| `edge-onboarding` | edge | template arc + rubrics | client `edge/ctx/*` + placement | chat |
| `edge-advisor` | edge | edge-kn · client workspace | client `edge/memory/`, ctx fixes · edge-inbox | chat |

## The memory-enabled variant

`anchor-interview-mem` replaces the `orient-profiles` plane with the platform's
multi-level memory: per-expert interviewing meta at `agent-user` (style, fatigue,
coverage log — area names only), org-wide interviewing craft at `agent-org`
(aggregates, never individuals), and the shared profile at `user`. The schemas
*are* the contamination guard, and a `## Memory` prompt section adds the read-side
rule: memory shapes *how* it interviews, never *what* it treats as known — any
memory entry that looks like practice content is ignored. Validated live 2026-08-11
(see the demo report artifact; findings there).

## Known gaps (as of 2026-08-12)

- **Outer loop open:** `edge-inbox` has no consumer; advisor gap notes route nowhere.
  `edge/examples/catalog.md` has no writer (hand-curated).
- **Client-work plane dead-ends:** no maintainer merges its contributions into any
  playbook; `anchor-session` has no client-work variant.
- **No schedules in code:** frame-keeper and maintainer must be scheduled by hand
  via the agent-builder; the continuation mechanism depends on the frame-keeper
  running. Most fragile link.
- **Interviews' no-read fence on `anchor-build` is prompt-only** (no per-connection
  read-mode; orient/frame-keeper get structural `disableTools` fences, the
  interviews don't). Frame-keeper's header flags the related prompt-injection
  residual risk.
- **Stale attribution:** all three interview prompts say "the maintainer updates the
  digest" mid-file; it's the frame-keeper (their own continuation sections say so).
- **`orient-profiles` vs memory unreconciled:** if that connection is bound, orient
  still maintains profiles even when spawned by the mem variant — continuity in two
  places.
- **Session filename collision:** `anchor/sessions/<name>_<date>` lacks the `_s<n>`
  suffix interviews have; same-day check-ins collide (frame-keeper dedups by name).
- **Contract evals live elsewhere** (`anchor-edge-experiments` repo) — this repo
  cannot verify the map-prohibition / contamination guards itself.
