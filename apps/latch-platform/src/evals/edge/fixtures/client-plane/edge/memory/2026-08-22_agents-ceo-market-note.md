---
summary: Memory note capturing the CEO advice and stage-appropriate rationale for this client.
---
# 2026-08-22 — CEO question: where the market is heading + what to do about agents (Q3/2026)

## Question

Where the market is heading, and what every CEO should do about agents as of Q3/2026.

## Answer (one recommendation)

Treat agents as a shift in *execution responsibility* (assist → agent → autonomous workflows). As a CEO in Q3/2026, the highest-leverage next step is to fund/require *agent run observability + governance* before expanding capability: make every unattended agent step produce a run history (trigger, context inputs, actions, changes, and stop reason), so you can improve trust, debug failures, and enable eval-driven iteration.

## Why this is stage-appropriate for this client (TwentyOne placement)

- They already ship agent steps inside workflows (builder/early agent) with unattended execution.
- The current highest weak point is lack of visibility into agent runs, which blocks transparency, learning loops/evals, and support escalations.
- Named next rung in placement: **Make agent runs observable**.

## Peer citation (used to ground the advice)

- Catalog example: Jobilla (copilot → agent) ships generate-then-refine plus evals-with-fallback logic.
- Catalog example: Duodecim (assist/copilot) invests in grounding + verification and eval frameworks in a high-trust domain.

## New facts / constraints learned

- No usage/adoption metrics are discussed for AI features.
- No eval infrastructure exists; prompt quality is assessed by hand.
- Agent context is assembled ad hoc per step; no context strategy.
- Run visibility is acknowledged as unowned/unscheduled.

## Gap logged

- The knowledge pillar explicitly says buyer/adoption shifts are not covered with stance-quality yet; any Q3/2026 “what buyers expect by default” claim would be a gap in this workspace.
