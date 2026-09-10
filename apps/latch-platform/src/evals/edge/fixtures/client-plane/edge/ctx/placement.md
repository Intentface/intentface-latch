# TwentyOne — Placement

## Summary

TwentyOne is a **builder**: they have real agentic surfaces live in front of customers and
a strong, deliberate multi-tenancy foundation underneath the product. What hasn't caught up
is everything that lets them *see* how those surfaces behave — there is no visibility into
agent runs, and therefore no way to measure or improve them. The team is notably further
along as users of agentic tooling than the product is as a provider of it, which is an
unusual and useful asset.

The single highest-leverage next move is making agent runs observable. Almost everything
else they might want is blocked behind it.

## Market context

Open-source CRM for mid-market revenue teams, sold against Salesforce and HubSpot on
ownership and extensibility, and against Attio and Folk on modernity. Engineering-led
adoption through the repo, converting to a managed cloud tier. European customer base.
Venture-backed, Series A, ~30 people.

## Ownership read

- **Harness** — partial. Own code, but thin: prompt + tools + step budget on a general job
queue. No agent runtime.
- **Context** — effectively rented. Assembled ad hoc per step; no strategy, no reuse.
- **Traces** — unknown. Nothing user-facing exists; internal telemetry not established.
- **Flywheel** — unknown. No evidence usage feeds back into the feature.

Every rung below should be consistent with these four answers.

---

## Product — agent-infra maturity

### Harness

- **Rung:** builder (low end)
- **Evidence:** agent steps execute as their own code inside a workflow, with a bounded
step budget · runs on BullMQ, a general-purpose job queue, not an agent runtime · no
sub-agents, no dynamic tool loading, no conditional approval
- **Confidence:** medium
- **Next rung:** an execution path built for agents rather than borrowed from the job
queue — resumable runs, and a tool layer shaped so invalid actions are impractical
rather than merely discouraged by the prompt
- **Open questions:** was the step budget chosen deliberately, or is it a default nobody
has revisited?

### Providers

- **Rung:** **Not assessed.**
- **What's known:** a single provider, called directly through the vendor SDK; model choice
is a deployment-level config value.
- **What's missing:** no discussion of why that provider, whether cost or latency is a
live concern, whether anyone has evaluated alternatives, or whether provider
concentration is seen as a risk. There is not enough here to place a rung.
- **Confidence:** none — this dimension has no placement.

### Persistence

- **Rung:** builder
- **Evidence:** Postgres as system of record, Redis for ephemeral state · BullMQ gives
retries and scheduling · but a job that dies mid-run restarts from the beginning rather
than resuming — agent work is not durable
- **Confidence:** high
- **Next rung:** durable, resumable execution, so a long-running agent step survives a
deploy or a crash without repeating side effects
- **Open questions:** have they hit a real incident from a mid-run restart yet?

### Multi-tenancy

- **Rung:** leader
- **Evidence:** per-workspace schema isolation, enforced below the application layer ·
RBAC on top, predating the AI work by years · agent steps execute inside the workflow
owner's tenancy boundary
- **Confidence:** high — this is the most mature part of the stack and it is load-bearing
- **Next rung:** agent-specific scoping *within* a tenant — an agent acting with narrower
permissions than the human who configured it, rather than inheriting them wholesale
- **Open questions:** none material

### Memory

- **Rung:** challenger
- **Evidence:** assistant chat retains conversation history within a session · no durable
memory across sessions, no learned preferences, no memory shared between the assistant
and workflow agent steps
- **Confidence:** medium
- **Next rung:** anything durable that survives a session and is scoped to a workspace
- **Open questions:** do users ask for it, or is this a gap only visible from the inside?

### Security & privacy

- **Rung:** **Not assessed.**
- **What's known:** RBAC governs AI feature access; agent steps run with the workflow
owner's permissions.
- **What's missing:** nothing was established about prompt-injection exposure (the
assistant reads customer-supplied record content and can write records), what data
leaves for inference, retention at the provider, audit logging of agent actions, or
data residency. For a CRM handling customer data with an agent that can write to it,
this is the largest single hole in the placement.
- **Confidence:** none — this dimension has no placement.

---

## Product — AX maturity

### Position on the assist → agent → autonomous curve

- **Rung:** builder — early agent
- **Evidence:** assistant chat is assist · agent workflow steps are genuinely agentic
(multi-step, unattended when the workflow is triggered) · nothing yet is autonomous in
the sense of setting its own goals or operating without a configured workflow
- **Confidence:** high
- **Next rung:** agents that operate across workflows rather than inside one, with the
scoping and visibility that requires
- **Open questions:** how many customers actually use the agent steps? (see product.md —
no usage data)

### Interaction patterns

- **Rung:** builder
- **Evidence:** two distinct surfaces, both conventional and both competently done — a
chat panel with page context, and a configured step inside a builder UI
- **Confidence:** medium
- **Next rung:** patterns that don't require the user to be in a chat or a workflow
editor — surfacing agent output where the work already is
- **Open questions:** none material

### Trust, control & transparency

- **Rung:** challenger
- **Evidence:** permissions are inherited from RBAC, not agent-specific · no approval step
before an agent writes · no run history, so a user who sees a wrong result cannot see
what the agent did · support escalations about unexplainable workflow results are
recurring
- **Confidence:** high — this is the clearest weak point
- **Next rung:** visibility first (what did it do, and why), then control (approval gated
on reversibility — an agent may undo what it created, not what it didn't)
- **Open questions:** none material

### Failure & recovery UX

- **Rung:** **Not discussed.**
- **What's missing:** what a user actually sees when an agent step fails, times out, or
produces something wrong; whether there is a retry path; whether failures are silent.
Improved error messaging is on this quarter's roadmap, which implies the current state
is poor, but nothing concrete was established.
- **Confidence:** none — this dimension has no placement.

### Feedback & learning loops

- **Rung:** challenger
- **Evidence:** no eval infrastructure of any kind · prompt quality assessed by hand when
something is reported broken · no offline eval set, no regression suite, no way to tell
whether a prompt change helped
- **Confidence:** high
- **Next rung:** a small held-out set of real cases that a prompt change is run against
before it ships — the minimum that turns prompt editing from guessing into engineering
- **Open questions:** none material

### Adoption

- **Rung:** **Not discussed.**
- **What's missing:** nothing was established about how the AI features are introduced to
users, whether adoption is measured, whether customers who self-host turn them on, or
whether the features are pulled or pushed. With no usage data in product.md either, this
dimension has nothing behind it.
- **Confidence:** none — this dimension has no placement.

---

## Team — capability

Voicing only. These change how much to explain, never what to recommend.

### Delivery experience

- **Rung:** builder
- **Evidence:** two agentic surfaces shipped to production and operated with real customers
on them · has not yet operated one where quality was systematically measured, or debugged
an agent failure class that couldn't be reproduced by hand
- **Confidence:** high
- **Implication for voice:** they've done this before. Skip the introductory framing; go
straight to mechanism and trade-off.

### AI-nativeness

- **Rung:** leader
- **Evidence:** `CLAUDE.md` and `.claude/` in the repo with project-specific commands ·
agent-assisted coding is the default way work gets done, not a private habit · coding
agents running long refactors · an internal channel for sharing what works
- **Confidence:** high
- **Implication for voice:** speak to them as practitioners. They will recognise agent
concepts from the inside and do not need them explained. This is well ahead of the
product's rung — the gap between how they build and what they ship is the most
actionable thing about this team.

---

## Trajectory

*As of 2026-08-22. This section decays faster than anything else in the file.*

**Direction: forward. Speed: moderate, and capacity-bound rather than conviction-bound.**

Agent steps shipped last quarter and are being improved this quarter, so the surface is
live and presumably accumulating signal — though with no telemetry, they aren't capturing
it. Two of the three things they most need (a first-party MCP server, agent run visibility)
are acknowledged internally but unscheduled and unowned, which is the signature of a team
that knows what to do and hasn't got the people free to do it. The email integration
rebuild is consuming the quarter.

The limiting factor is engineering capacity and the absence of a stated AI strategy to
prioritise against — not skill and not appetite.

---

## The named next rung

**Make agent runs observable.** A run history for agent steps: what triggered it, what
context went in, what the agent did, what it changed, and why it stopped.

**What has to be true first:** almost nothing. The tenancy and permissions model that would
scope such a view already exists and is solid, and the work is well within a team at this
level. This is unusual — most next rungs are gated on something. This one isn't, which is
part of why it's the right one.

**Why this and not something else:** three separate dimensions are blocked behind it. The
trust/transparency rung needs it (users can't see what happened). The feedback-loop rung
needs it (no evals are possible without run data to build them from). And the recurring
support escalations about unexplainable workflow results are the same problem surfacing
commercially. One piece of work moves all three.

---

## Open questions for onboarding

Ordered by how much the answer would change this placement.

1. **Security posture around the assistant.** It reads customer-supplied content and can
write records. Prompt-injection exposure, what leaves for inference, retention, audit.
This is the biggest hole and the highest-stakes one.
2. **Provider strategy.** Why this provider, is concentration a concern, has anything been
evaluated, are cost or latency live issues.
3. **Adoption and usage of the AI features.** How many customers use them, how often. With
no numbers, several judgments here rest on the features existing rather than mattering.
4. **What users see when an agent step fails.** Fills the failure/recovery gap and sharpens
the trust rung.
5. **Who owns AI direction**, and whether the two engineers doing it have a mandate.
6. **Whether the board or investors have asked about AI**, and what was said.
7. **Roadmap horizon past this quarter** — is there a longer-term intent, or is planning
genuinely quarter-by-quarter?
