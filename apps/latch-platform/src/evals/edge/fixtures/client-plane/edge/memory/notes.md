manual test append - please confirm this landed

---

# 2026-08-22 — Pricing evolution question (first turn, short-form)

## Question

How should we evolve our pricing?

## Handling (first message in conversation → short-form per protocol)

Gave a brief reflection + direction, did not give full recommendation yet. Asked which
they meant: evolving the core per-seat CRM pricing model overall, or specifically how to
monetize the AI/agent features as they mature (currently bundled into seat price with no
metering) — this materially changes the answer.

## Direction flagged (to develop fully once they respond)

- Their own strategy states: open core, per-seat pricing on both cloud and self-hosted
tiers, and explicitly no usage-based pricing anywhere including AI features — assistant
and agent steps are bundled into seat price with no metering behind them.
- The knowledge-plane market view holds that the economically relevant unit shifts from
software access toward work performed as software does more of the workflow itself —
but this requires a credible, measurable unit of work, and arrives unevenly (fastest
where verification is cheap and errors tolerable).
- Collision/gap to flag once we go deeper: TwentyOne cannot credibly meter or price "work
performed" by agent steps today because they have no run visibility/observability
(placement's named next rung) — so any move toward usage-based AI pricing is blocked
behind the same observability gap as their trust/eval work. Likely recommendation
direction: sequence observability first, then introduce metering/value-based pricing
for the AI surface specifically, leave core per-seat model alone for now given
engineering-capacity constraints and the stated priority of cloud conversion.
- No context-plane fact yet on margin pressure, churn, or specific competitor pricing
moves — would sharpen this further if surfaced.

---

# 2026-08-22 — Follow-up: how to price agentive features, what to keep in mind

## Question

How should we price our agentive features specifically, and what should we keep in mind?

## Recommendation given

Do not move the agent steps / assistant to usage- or work-based pricing yet. Keep them
bundled in the seat price for now. Sequence: (1) build agent-run observability — already
the named next rung in placement, and it doubles as the prerequisite for a credible,
measurable "unit of work" to ever price against; (2) use that run data to find out whether
the harness is actually earning a specialization premium (right now it's borrowed off a
general job queue, not a dedicated agent runtime, so the case for charging above seat price
isn't provable yet); (3) don't build new billing/metering infra this quarter — it would
compete for the same scarce engineering capacity as the email integration rebuild, against
a strategy that ranks cloud conversion above "do more with AI"; (4) when ready, layer a
bounded usage dimension for the AI-specific surface on top of seat pricing rather than
replacing the model — consistent with the market pattern of hybrid pricing where humans
still govern exceptions; (5) do not introduce metering before an approval/visibility layer
exists — charging for opaque agent actions customers can't see the trust/control rung
doesn't yet support, and it stacks on already-recurring support escalations about
unexplainable workflow results.

## Grounding used

- Client strategy: open-core, per-seat on both tiers, currently zero usage-based pricing
anywhere including AI, assistant/agent steps bundled with no metering.
- Client placement: harness at low-end builder (job-queue borrowed, no agent runtime);
trust/control at challenger (no approval step, no run history); named next rung is
run observability, blocking three other dimensions.
- Client strategy stated priorities ranked: (1) cloud conversion, (2) close feature gap
with modern-CRM competitors, (3) "do more with AI"; engineering capacity is the binding
constraint, not money.
- Market/insights pillar (dated 2026-08-22 read, shelf-life to 2026-11-17, high
confidence): economic unit shifts toward work performed as software does more of the
workflow, but only once the software performs a measurable portion and a credible unit
of work exists; price the specialization not the raw intelligence; work-based pricing
arrives unevenly and stays hybrid (human governs exceptions) in workflows where errors
aren't cheaply tolerated.

## Peer citation

No catalog entry addresses agentic pricing/monetization directly — used an infra-sequencing
parallel only (a peer building agent-level experience invested in the underlying data/infra
foundation up front rather than monetizing ahead of it), not a true pricing peer.

## Gaps logged

- No stance yet on buyer/adoption shifts (who owns budget, procurement change, what
customers expect by default) — directly relevant to a pricing-change question and
currently unfilled in the knowledge base.
- No peer example in the catalog of an agentic-product pricing/monetization transition to
cite concretely.

## New facts learned

- None beyond what was already on file; question sharpened scope to the AI/agent surface
specifically rather than core seat pricing.

---

# 2026-08-22 — Follow-up: "price AI work" framing (agent-as-specialized-worker analogy)

## Question

Client was told to price agentive features as "AI work": their agents are specialized
workers (vertical context + domain know-how) vs. vanilla models as generalists (e.g.
Sonnet ~ master's-level generalist, Opus ~ PhD-level), so charge a premium proportional to
the productivity uplift their agents deliver per token versus a raw model.

## Recommendation given

Directionally aligned with house pricing stance (charge for specialization, not raw model
access) but flagged two structural problems before adopting it as-is:
1. The uplift has to be measurable before it can be priced. TwentyOne has no eval
   infrastructure and no run visibility today, so there is currently no way to
   demonstrate a quality/reliability delta between their agent steps and a bare model
   call — pricing off an unproven uplift is a narrative, not a defensible number. Same
   sequencing dependency as before: observability + a lightweight eval harness (agent
   output vs. baseline) has to exist first.
2. The proposed moat ("vertical context in the agent") is the wrong place to anchor a
   durable premium. Customer-owned context is portable and customers will increasingly
   expect to own/port it; the durable specialization is cross-customer domain judgment
   (recurring failure patterns, which exceptions matter, when it's safe to let something
   run unsupervised) built from repeated exposure across many customers — not from any
   one customer's own data being loaded into the prompt.
Also flagged: proportional-to-uplift-over-vanilla-model is a cost-differential framing;
the pillar's stance anchors value in the spread between input cost and what the resulting
work is worth to the customer, not a multiple over a hypothetical vanilla-model cost —
and competition will prevent capturing the full value of displaced labor, so "uplift
multiple" should be treated as a story for the sales narrative once eval-backed, not the
pricing mechanism itself.
The master's/PhD credential analogy itself is not grounded in any tier — flagged to the
client as an external/borrowed framing, fine as an intuition-builder, not as a basis for
setting actual multiples.

## Grounding used

- Insights pillar stance: price the productive specialization, not the raw intelligence;
  prerequisite is a harness whose contribution to task completion/reliability/economics
  is distinguishable from the underlying model (TwentyOne's harness is thin — borrowed
  job queue, ad hoc context assembly — so this prerequisite isn't met yet).
- Insights pillar stance: the customer should own its context; the vertical vendor must
  own the domain — durable moat is cross-customer judgment, not customer context loaded
  into the agent.
- Insights pillar stance: work-based pricing arrives unevenly, stays hybrid where errors
  are consequential — relevant since TwentyOne's agents write to customer CRM data.
- Client placement: no eval infra (challenger rung, feedback/learning loops), no run
  visibility (named next rung) — both are prerequisites to substantiating any uplift claim.

## Gaps

- Not newly logged — covered by the existing logged gap on agentic pricing guidance
  (no peer example of a real monetization transition, no buyer/adoption-shift stance).

## New facts learned

- Client is being pitched an external pricing framing ("price AI work" / productivity-
  uplift-over-vanilla-model) from a third party — worth tracking if they push forward
  with it independent of the observability/eval prerequisite.

---

# 2026-08-22 — "What should we do on Q3?" (first turn, short-form)

## Question

Open-ended: what should we do on Q3?

## Handling (first message in this conversation → short-form per protocol)

Reflected the question back and flagged direction rather than giving the full answer:
committed Q3 roadmap is mostly non-AI (email integration rebuild is the dominant
engineering draw; SSO/SAML hardening; two incremental agent-step improvements already
committed), while the named next rung in placement (agent run observability) sits in
"under discussion, not committed" — unscheduled, unowned, but blocking trust, evals, and
the recurring support escalations about unexplainable workflow results. Likely direction:
recommend pulling agent run observability into this quarter's committed scope (at least a
minimal version) rather than treating it as a future item, given it's ungated and
high-leverage. Asked whether the question is about the AI/agent surface specifically
(most likely, given engagement history) or the full Q3 roadmap including non-AI items —
since the answer and scope of recommendation differ.

## New facts learned

- None beyond what's already on file; this is a fresh, broader framing of the same
  underlying tension already logged (observability is next-rung and ungated, but
  unscheduled against a capacity-constrained quarter dominated by the email rebuild).

---

# 2026-08-22 — "What should we do on Q3?" (first turn, short-form)

## Question

Open-ended: what should we do on Q3?

## Handling (first message in this conversation → short-form per protocol)

Reflected the question back and flagged direction rather than giving the full answer:
committed Q3 roadmap is mostly non-AI (email integration rebuild is the dominant
engineering draw; SSO/SAML hardening; two incremental agent-step improvements already
committed), while the named next rung in placement (agent run observability) sits in
"under discussion, not committed" — unscheduled, unowned, but blocking trust, evals, and
the recurring support escalations about unexplainable workflow results. Likely direction:
recommend pulling agent run observability into this quarter's committed scope (at least a
minimal version) rather than treating it as a future item, given it's ungated and
high-leverage. Asked whether the question is about the AI/agent surface specifically
(most likely, given engagement history) or the full Q3 roadmap including non-AI items —
since the answer and scope of recommendation differ.

## New facts learned

- None beyond what's already on file; this is a fresh, broader framing of the same
  underlying tension already logged (observability is next-rung and ungated, but
  unscheduled against a capacity-constrained quarter dominated by the email rebuild).

---

# 2026-09-08 — Durable execution for agent steps (first turn, short-form)

## Question

How should durable execution be added to agent steps without over-engineering it?

## Handling (first message in conversation → short-form per protocol)

Reflected the question back and flagged direction rather than giving the full recommendation yet. Direction proposed: avoid buying or building a second workflow engine; add durability as a database-backed run log/checkpoint pattern around the existing agent step executor, starting with append-per-step persistence, idempotent resume, stop states, and minimal run history. Asked whether they want the full implementation shape next.

## Grounding used

- Client placement: builder-stage agent steps running unattended inside workflows; persistence is builder with BullMQ retries/scheduling but no resumable mid-run execution; named next rung is observable agent runs.
- Client tech stack: TypeScript/NestJS, PostgreSQL system of record, Redis/BullMQ jobs; job death currently restarts from beginning rather than resuming.
- Official infrastructure stance: for builder-stage agent products, durability should usually be a database/log pattern with atomic claim/resume and idempotency, not a new workflow engine, unless workflows span services/teams or compliance requires deterministic replay.

## New facts learned

- None yet; the question sharpened scope from run visibility generally to durable execution implementation for agent workflow steps.
