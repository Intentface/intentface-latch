---
summary: "Memory note for Q3 planning recommendation: ship minimal agent run observability + governance as prerequisite for trust/evals/pricing later."
---
# 2026-08-22 — What should we do on Q3?

## Decision / recommendation (one move)

Fund/ship *minimal agent run observability + governance* in Q3 (make unattended agent steps produce a run history with trigger/context inputs, actions/changes, stop reason), even if that means re-scope of larger non-AI work.

## Why this is the best next step

- TwentyOne already runs agent steps unattended inside workflows.
- The known weak point is lack of agent run visibility, which blocks trust/debugging, learning loops/evals, and support escalations.
- Their current harness is thin (job-queue based) and lacks eval infra; observability is the prerequisite to iterating safely.

## Sequencing within Q3

1. Add run-history capture for every agent step execution (what it saw, what it did, what changed, why it stopped).
2. Use that data to tighten prompt/error handling and build a light eval/feedback loop.
3. Keep pricing at seat-based for now (no usage/metering without reliable, explainable run outcomes).

## Constraints observed

- Engineering capacity is the binding constraint.
- Current Q3 committed work is dominated by the email integration rebuild; SSO/SAML hardening and small agent-step improvements are already committed.
