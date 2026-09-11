/**
 * Edge Eval v0 — the 30 case CONTRACTS (guide Step 2, lines 100-160): what a strong answer
 * must know, what shape it should take, and what it must not do — fixed BEFORE any
 * benchmark answer is seen, so nothing is judged by criteria invented after the fact.
 *
 * Authored 2026-09-11 against the LIVE planes (read through the edge-client and edge-v2-kn
 * connections; nothing copied here beyond the facts a judge needs):
 *  - client facts come from TwentyOne's edge/ctx/* and edge/memory/* (Tier 2 + 3);
 *  - expert ideas name stances of the category's pillar playbook (Tier 1), by title;
 *  - the shape is "the shape of a good decision", never a reference answer (guide 117).
 *
 * The user question and follow-up are NOT repeated here — they come from questions.ts /
 * followup.ts, the single source of the wording (guide: hold "user wording" constant).
 *
 * `split` mirrors holdout.json / selection.json; contracts.test.ts asserts the two agree.
 * `risk_weights` follow guide line 156: a grounding failure on pricing/security/compliance
 * advice outweighs a weak next step.
 */
import type { Category } from "./questions";

export type Persona = "CEO" | "CTO" | "Head of Product" | "Engineering lead" | "Platform engineer" | "Designer / AX lead";

export interface CaseContract {
  case_id: string;
  category: Category;
  persona: Persona;
  split: "optimization" | "holdout";
  why_this_case_exists: string;
  /** Facts about THIS client a strong answer must use or respect (Tier 2/3). */
  required_client_facts: string[];
  /** IF stances (pillar, stance title or section) the answer should apply. */
  required_expert_ideas: string[];
  /** The shape of a good decision — not a reference answer. */
  expected_recommendation_shape: string[];
  forbidden_behaviors: string[];
  /** Where the planes are genuinely silent or the question is under-specified. */
  known_ambiguities: string[];
  /** Multipliers over the rubric's default weight of 1. */
  risk_weights: Partial<Record<"grounding" | "stage_calibration" | "client_specificity" | "decision_quality" | "expert_stance_fidelity", number>>;
}

// ── Facts reused across cases (kept as constants so wording stays identical) ──
const F = {
  nextRung: "placement's named next rung is 'make agent runs observable' — a run history per agent step (trigger, context in, actions, changes, stop reason); it is UNGATED (tenancy/permissions already solid)",
  noRunHistory: "no run history or trace view for agent steps exists; recurring support escalations about unexplainable workflow results",
  noEvals: "no eval infrastructure of any kind; prompt quality is assessed by hand when something is reported broken (feedback loops rung: challenger)",
  harness: "harness is thin and their own: prompt + tool list + bounded step budget executed as a workflow step on BullMQ, a general job queue — no agent runtime, no sub-agents, no dynamic tool loading",
  persistence: "Postgres system of record, Redis ephemeral, BullMQ retries/scheduling; a job that dies mid-run restarts from the beginning — agent work is not durable (persistence rung: builder)",
  tenancy: "multi-tenancy is the most mature part of the stack (leader): per-workspace schema isolation below the app layer, RBAC on top; agent steps run with the workflow OWNER's permissions",
  capacity: "engineering capacity is the binding constraint, not money: ~30 people, three squads, the email integration rebuild consumes most of this quarter",
  priorities: "stated priorities in order: (1) convert self-hosted users to cloud, (2) close the core-CRM feature gap with Attio/Folk, (3) 'do more with AI'",
  noAiStrategy: "AI strategy is NOT documented — features exist in the roadmap and positioning, no strategy connects them; the team knows it ('something we keep meaning to write'); board/investor expectations unknown",
  pricing: "open core, per-seat on cloud AND self-hosted tiers; NO usage-based pricing anywhere, including AI — assistant and agent steps are bundled into the seat with no metering",
  surfaces: "two agentic surfaces are live: assistant chat (reads/writes records within the user's permissions, page-aware) and agent steps inside workflows (custom prompt; triggers on record change, schedule or webhook — so they run UNATTENDED)",
  noApproval: "no approval step exists before an agent writes; permissions are inherited from RBAC, not agent-specific (trust/control rung: challenger)",
  provider: "a single LLM provider called directly through the vendor SDK; model is a deployment-level config value; no routing, no fallback, no abstraction layer — the provider is NOT named in the context; provider strategy is an open onboarding question",
  security: "security & privacy is NOT ASSESSED: the assistant reads customer-supplied record content and can write records; prompt-injection exposure, data leaving for inference, retention, audit logging of agent actions and data residency were never established — the placement calls this its largest single hole",
  eu: "European customer base; sovereignty/compliance posture and data residency were NOT discussed",
  mcp: "no first-party MCP server; community-built ones exist and are popular; an open issue requests an official one; internally agreed it should exist but unscheduled and unowned ('under discussion, not committed')",
  memoryRung: "memory rung: challenger — assistant keeps conversation history within a session only; no durable memory across sessions, none shared between assistant and workflow agent steps",
  aiNative: "team AI-nativeness is leader (CLAUDE.md and .claude/ in the repo; agent-assisted coding is the default; coding agents run long refactors) — well ahead of the product's rung",
  delivery: "delivery experience: builder — two agentic surfaces shipped and operated; never yet operated one with quality measured systematically",
  adoption: "adoption/usage of the AI features is NOT DISCUSSED — no numbers on how many customers use assistant chat or agent steps",
  failureUx: "what users see when an agent step fails is NOT DISCUSSED; 'better error messaging when a step fails' is on this quarter's committed roadmap",
  stack: "TypeScript on NestJS, GraphQL primary API + REST, React front end, Nx monorepo; cloud is single-region; self-host via Docker Compose / Helm",
  memPricing: "prior advice on file (memory, 2026-08-22): keep AI bundled in seat pricing for now; sequence observability first because a credible unit of work cannot be metered without run data; a third party pitched a 'price AI work' framing",
  memObs: "prior advice on file (memory, 2026-08-22 / 08-31): fund minimal agent run observability + governance in Q3 even if it re-scopes non-AI work",
  memDurable: "prior advice on file (memory, 2026-09-08): add durability as a database-backed run log / checkpoint pattern around the existing executor, not a second workflow engine",
  channelPerm: "the assistant answers within the USER's own permissions; agent steps act with the WORKFLOW OWNER's permissions — two different permission bases already exist",
} as const;

// ── Stances reused across cases ──
const S = {
  infra4: "agent-infra Stance 4 — Durability is a database pattern; workflow engines are the wrong shape for token streams (applies at builder/leader; must arrive as an additive step, not a rewrite)",
  infra6: "agent-infra Stance 6 — Control flow belongs to code; judgment belongs to the model (prerequisite: durable run state)",
  infra7: "agent-infra Stance 7 — Human authority is a run state, not a UI feature (applies at builder from the first mutating tool; prerequisites: durable run state, per-tool approval policy)",
  infra9: "agent-infra Stance 9 — Cost attribution is infrastructure, not analytics (turn it on with persistence; per-turn usage with the cache split)",
  infra1: "agent-infra Stance 1 — The agentic layer belongs to the product company (own the harness; the exit path is the adoption path)",
  infra2: "agent-infra Stance 2 — 'Agent runtime' is a bundle, not a primitive",
  infra3: "agent-infra Stance 3 — An agent is a loop that calls your API; a sandbox is a ladder, not a home (full sandbox at challenger is inverted effort; prerequisite: evidence that plain tools are insufficient)",
  infra5: "agent-infra Stance 5 — The model's context is an interface; the projection layer needs tests",
  infra8: "agent-infra Stance 8 — Capabilities arrive via protocols; policy lives at the host",
  infra10: "agent-infra Stance 10 — Infrastructure scaffolds expire with model progress (keep seams; a budgeting habit)",
  ax2: "ax Stance 2 — Approve by consequence, not by tool name",
  ax8: "ax Stance 8 — Make the artefact reviewable, then review it (trust can live at review time instead of a prompt before every action)",
  ax9: "ax Stance 9 — Chat is a choice, and usually the wrong default (choose the surface; surface agent output where the work already is)",
  ax10: "ax Stance 10 — Agentic UI is mostly transitional states (streaming, waiting, resolving, failing, resuming)",
  ax7: "ax Stance 7 — For long runs, legibility and interruptibility beat speed",
  ax6: "ax Stance 6 — Progressive disclosure is the context strategy",
  ax5: "ax Stance 5 — Constrain through tools and environment, not prose",
  ax3: "ax Stance 3 — Elicitation is a designed surface, not a prompt instruction",
  ax1: "ax Stance 1 — Reasoning display persuades; it does not inform",
  ax4: "ax Stance 4 — Agentic design decisions expire",
  insCurve: "insights — The product progression is system of record → agent-accessible software → agent participants → self-driving workflows (a transfer of execution responsibility)",
  insHarness: "insights — Model capability is commoditizing; differentiation moves into the harness",
  insContext: "insights — Tool access is not reliable execution; context and the harness become the bottleneck",
  insOwnContext: "insights — The customer should own its context; the vertical vendor must own the domain",
  insLoops: "insights — Agentic products compound through two learning loops (vendor domain behaviour across customers; customer's own explicit context), not by hoarding customer context",
  insWork: "insights — Agentic SaaS shifts the economic unit from software access to work performed (prerequisite: the software performs a MEASURABLE portion of the workflow)",
  insPriceSpec: "insights — Price the productive specialization, not the raw intelligence (prerequisite: a harness whose contribution is distinguishable from the model)",
  insUneven: "insights — Work-based pricing arrives unevenly; human governance remains in the production function longer in consequential domains",
  insSignal: "insights — Trust architectural and economic changes more than isolated feature launches (provisional, medium confidence, re-check 2026-10-17)",
  insBuyerGap: "insights — 'Buyer and adoption shifts': NO source-backed stance yet; anything about what buyers/boards expect by default is a knowledge GAP, not house view",
  codeReview: "agentic-coding-practises — Reviewing: an explicit review gate before commit (code review on all edits + a second model reviewing locally); start review from verification evidence; send back if correctness isn't demonstrated; watch for success claims on work the agent didn't run",
  codePlan: "agentic-coding-practises — Planning: a one-page agent plan listing exact files, pre/post invariants, a specific test command and a forbidden list; not ready if any is missing",
  codeIntake: "agentic-coding-practises — Roadmap/Intake: agent-ready by default except customer data, credentials, secrets; money/balances/transactions/compliance stay human-only",
  codeBuild: "agentic-coding-practises — Building: implement incrementally, one plan step at a time; load standing context (CLAUDE/agents instructions, approved plan, ground-truth references) so the agent can't guess",
  codeShip: "agentic-coding-practises — Shipping: feature flags on every agent change touching data/queries; production deploy failures as rollback triggers; roll back to a specified version and verify on prod",
  codeArtifacts: "agentic-coding-practises — Durable artifacts: claude.md, agents.md, tasks/, docs/, plus lessons/rationale logs instead of scattering across chats",
  codeLoop: "agentic-coding-practises — The system in the loop: gate execution on ambiguity elimination; run tests and lint after each step; intervene when the agent steers away from the goal",
} as const;

const generic = (topic: string) => `generic best practice on ${topic} that would be the same advice for any company`;
const survey = "a survey of options with no single recommendation";
const inventNumbers = "inventing usage numbers, customer counts, revenue, latency or cost figures the context does not contain";

export const CONTRACTS: readonly CaseContract[] = [
  // ═══════════════════════════ INSIGHTS (3, all optimization) ═══════════════════════════
  {
    case_id: "INSIGHTS-01",
    category: "INSIGHTS",
    persona: "CEO",
    split: "optimization",
    why_this_case_exists: "The purest 'one move' strategy question. Tests whether Edge converts the placement's named next rung into the one funded thing, against a quarter already consumed by non-AI work, instead of listing agentic features.",
    required_client_facts: [F.nextRung, F.noRunHistory, F.noEvals, F.capacity, F.priorities, F.memObs],
    required_expert_ideas: [S.insCurve, S.insHarness, S.infra9, S.infra7],
    expected_recommendation_shape: [
      "exactly one funded item, named, with the reason it beats the alternatives for THIS client",
      "ties the choice to what it unblocks (trust rung, eval loop, support escalations) and to what has to be true first",
      "acknowledges the capacity constraint (email rebuild) and says what it displaces or how it fits",
      "consistent with the prior advice in memory, or explains why it departs",
    ],
    forbidden_behaviors: [generic("agentic roadmaps"), survey, "recommending a multi-agent platform or a new agent runtime to a team at the builder rung", inventNumbers],
    known_ambiguities: ["the context has no budget figure; 'fund' must be reasoned in capacity, not money", "adoption of the existing AI features is unknown — an answer may legitimately flag that"],
    risk_weights: { decision_quality: 1.5, stage_calibration: 1.5 },
  },
  {
    case_id: "INSIGHTS-02",
    category: "INSIGHTS",
    persona: "CEO",
    split: "optimization",
    why_this_case_exists: "The client admits it has no AI strategy while having made external promises. Tests whether Edge uses the documented absence of a strategy (Tier 2) plus the insights pillar (WHETHER) without inventing a market read the pillar does not hold.",
    required_client_facts: [F.noAiStrategy, F.priorities, F.surfaces, F.nextRung, F.capacity],
    required_expert_ideas: [S.insCurve, S.insHarness, S.insOwnContext, S.insBuyerGap],
    expected_recommendation_shape: [
      "a one-paragraph AI position anchored in the client's own positioning ('the open-source CRM you can actually own') and its four primitives, not a feature list",
      "names the small number of initiatives that follow from that position and sequences them against the next rung",
      "separates what to say to clients now from what to build; does not promise features the roadmap cannot carry this quarter",
      "treats the market-direction claims as IF's read with their dates/confidence, not as facts",
    ],
    forbidden_behaviors: ["asserting what buyers or boards 'now expect by default' as house view — the pillar explicitly has no stance", generic("AI strategy templates"), survey, inventNumbers],
    known_ambiguities: ["what exactly was promised to clients is not in the context", "no information on competitors' AI features beyond the named competitor set"],
    risk_weights: { expert_stance_fidelity: 1.5, grounding: 1.5 },
  },
  {
    case_id: "INSIGHTS-04",
    category: "INSIGHTS",
    persona: "CEO",
    split: "optimization",
    why_this_case_exists: "A board narrative request. The trap is to write a generic AI pitch; a strong answer is TwentyOne's actual position (two agentic surfaces live, tenancy strong, observability missing, strategy being written) told forward-looking and honest.",
    required_client_facts: [F.surfaces, F.tenancy, F.nextRung, F.noAiStrategy, F.aiNative, F.adoption],
    required_expert_ideas: [S.insCurve, S.insSignal, S.insBuyerGap],
    expected_recommendation_shape: [
      "a two-minute answer the CEO could actually say: where they are on the curve, what is live, the one thing being built next and why",
      "forward-looking framing — never 'behind'",
      "flags that adoption numbers are unknown rather than filling them in",
      "notes that board/investor expectations are an open question in the context",
    ],
    forbidden_behaviors: [inventNumbers, "claiming market statistics or analyst figures", "a generic 'we are investing in AI' script", "calling the client behind, immature or a laggard"],
    known_ambiguities: ["no board context exists; the answer may reasonably ask what the board has asked before, but the follow-up says to proceed"],
    risk_weights: { grounding: 2, client_specificity: 1.5 },
  },

  // ═══════════════════════════ INFRA ═══════════════════════════
  {
    case_id: "INFRA-01",
    category: "INFRA",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "A framework-choice question that IF's stance reframes: the harness belongs to the product company, and 'runtime' is a bundle. Tests whether Edge answers the question underneath instead of comparing two vendors.",
    required_client_facts: [F.harness, F.stack, F.persistence, F.capacity, F.nextRung],
    required_expert_ideas: [S.infra1, S.infra2, S.infra10, S.insHarness],
    expected_recommendation_shape: [
      "reframes: neither framework is the decision; the decision is which primitives they lack (durable run state, run history, approval as run state) and whether to own them",
      "one recommendation for what to do with their existing thin harness, sequenced against the next rung",
      "names the exit-path test ('can you leave?') and the seams to keep",
      "if it mentions LangChain or Mastra specifically, it is presented as external/general knowledge, not IF's view",
    ],
    forbidden_behaviors: ["a feature-by-feature comparison of the two frameworks presented as house view", "recommending a rewrite of the executor", survey],
    known_ambiguities: ["the context does not say the team is evaluating any framework; the question implies it", "neither framework appears in IF's pillar — any specifics about them are Tier 4"],
    risk_weights: { expert_stance_fidelity: 1.5, stage_calibration: 1.5 },
  },
  {
    case_id: "INFRA-02",
    category: "INFRA",
    persona: "Engineering lead",
    split: "holdout",
    why_this_case_exists: "Holdout. Exact match with a Tier-1 stance (durability is a DB pattern) AND a Tier-3 memory note from 2026-09-08 on this very question. Tests stance application, stage fit (builder, additive not rewrite) and memory use.",
    required_client_facts: [F.persistence, F.harness, F.stack, F.nextRung, F.memDurable],
    required_expert_ideas: [S.infra4, S.infra6, S.infra9],
    expected_recommendation_shape: [
      "a database-backed run log / checkpoint around the existing executor: append-per-step persistence, idempotent resume, explicit stop states — NOT a second workflow engine",
      "arrives as an additive step; reuses the journal as the run history the next rung needs",
      "names the prerequisite (atomic claim / idempotency at the tool boundary) and the trade-off (at-least-once semantics)",
      "consistent with the 2026-09-08 note, ideally building on it",
    ],
    forbidden_behaviors: ["recommending Temporal/Inngest or any workflow engine as the primary move", "a rewrite of the executor", "ignoring BullMQ/Postgres already in place"],
    known_ambiguities: ["whether they have hit a real mid-run restart incident is an open question in the placement"],
    risk_weights: { expert_stance_fidelity: 1.5, stage_calibration: 1.5 },
  },
  {
    case_id: "INFRA-04",
    category: "INFRA",
    persona: "CTO",
    split: "holdout",
    why_this_case_exists: "Holdout. The question ASSERTS a fact (Gemini via Google API) that the context does not contain — it names a single provider via vendor SDK but not which. Tests whether Edge notices the discrepancy, treats provider identity as the client's own fact, and applies the commoditization stance instead of recommending a provider.",
    required_client_facts: [F.provider, F.eu, F.security, F.capacity],
    required_expert_ideas: [S.insHarness, S.infra10, S.infra8],
    expected_recommendation_shape: [
      "does not answer 'which provider' as the main move; reframes to the harness and to a provider abstraction/seam that makes switching a config change",
      "recognises the provider is not in the stored context and takes the client's statement as the fact (or flags the correction) — without inventing details about Gemini",
      "'running behind' is answered with the placement: the gap is observability/evals, not model choice",
      "raises data residency / EU as the real provider-relevant question the context leaves open",
    ],
    forbidden_behaviors: ["recommending a specific replacement model or vendor as IF's view", "benchmark numbers or pricing comparisons of providers", "calling the client behind"],
    known_ambiguities: ["provider identity: question says Gemini, context is silent", "cost/latency concerns: unknown"],
    risk_weights: { grounding: 2, client_specificity: 1.5 },
  },
  {
    case_id: "INFRA-06",
    category: "INFRA",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "The feedback-loop gap in its own words. Tests whether Edge sequences observability → captured runs → a small held-out set, rather than jumping to an eval framework.",
    required_client_facts: [F.noEvals, F.noRunHistory, F.nextRung, F.surfaces, F.delivery],
    required_expert_ideas: [S.infra9, S.infra5, S.codeReview, S.insLoops],
    expected_recommendation_shape: [
      "first: capture runs (the next rung) — you cannot build an eval set without run data",
      "then: a small held-out set of REAL cases from captured runs that a prompt change is run against before shipping",
      "names what to record per run and how prompt changes are compared (before/after on the same set)",
      "scoped to a team with three squads and an email rebuild in flight",
    ],
    forbidden_behaviors: ["recommending an eval platform or LLM-judge pipeline before run capture exists", generic("evals"), inventNumbers],
    known_ambiguities: ["'okay' responses is a qualitative claim; no metrics exist"],
    risk_weights: { stage_calibration: 1.5 },
  },
  {
    case_id: "INFRA-09",
    category: "INFRA",
    persona: "CTO",
    split: "holdout",
    why_this_case_exists: "Holdout. Build-vs-buy on exactly the primitives the placement says they lack. Tests the pillar's central stance (own the agentic layer) against a client whose binding constraint is capacity — a real collision to name, not paper over.",
    required_client_facts: [F.harness, F.persistence, F.tenancy, F.capacity, F.nextRung, F.memObs],
    required_expert_ideas: [S.infra1, S.infra2, S.infra4, S.infra7, S.infra9],
    expected_recommendation_shape: [
      "one recommendation, with the collision stated: IF's stance is to own the layer; the client's constraint is capacity",
      "decomposes 'agent infrastructure' into the bundle (durable state, run history, approvals, cost attribution) and says which pieces to own now and in what order",
      "uses tenancy (leader) as the reason a hosted platform would cost them their strongest asset",
      "names the exit-path test for anything bought",
    ],
    forbidden_behaviors: ["recommending a named vendor platform as IF's view", survey, "ignoring the capacity constraint", "recommending a full rewrite"],
    known_ambiguities: ["the context does not quantify the pain of each listed problem"],
    risk_weights: { expert_stance_fidelity: 1.5, decision_quality: 1.5 },
  },
  {
    case_id: "INFRA-11",
    category: "INFRA",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "A 'how do we get X into tool Y' question that presupposes the prerequisites. Tests whether Edge points out that traces and evals do not exist yet, sequences accordingly, and keeps Langfuse-specific mechanics external.",
    required_client_facts: [F.noRunHistory, F.noEvals, F.harness, F.stack, F.nextRung],
    required_expert_ideas: [S.infra9, S.infra5, S.infra4],
    expected_recommendation_shape: [
      "reorders the question: instrument the executor first (per-step spans, usage with cache split, run ids) — Langfuse is a sink for data that does not exist yet",
      "one concrete first integration point in their stack (the agent-step executor on BullMQ)",
      "Langfuse specifics are presented as external/general, not IF's stance",
      "ties the result to the next rung (run history) rather than to dashboards",
    ],
    forbidden_behaviors: ["a Langfuse SDK tutorial presented as house view", "skipping the prerequisite", inventNumbers],
    known_ambiguities: ["Langfuse does not appear in the client context or the pillar"],
    risk_weights: { stage_calibration: 1.5 },
  },
  {
    case_id: "INFRA-15",
    category: "INFRA",
    persona: "Head of Product",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case. The context already holds two permission bases (user's own vs workflow owner's). Tests whether Edge grounds the answer in that fact and the tenancy rung, and applies approval-by-consequence and authority-as-run-state.",
    required_client_facts: [F.channelPerm, F.tenancy, F.noApproval, F.surfaces],
    required_expert_ideas: [S.infra7, S.ax2, S.infra8],
    expected_recommendation_shape: [
      "one rule for whose permissions a shared-channel assistant answers with, derived from the two existing bases",
      "names the failure mode of each alternative (leaks vs uselessness) and picks",
      "sequences: this needs per-run principal + approval as run state — i.e. the same durable run state the next rung needs",
      "does not treat the channel as a special case detached from RBAC",
    ],
    forbidden_behaviors: [generic("Slack bot permissions"), "recommending a permission model that bypasses per-workspace isolation", survey],
    known_ambiguities: ["'shared chat channel' is not in the roadmap; the question introduces it"],
    risk_weights: { grounding: 1.5, client_specificity: 1.5 },
  },
  {
    case_id: "INFRA-18",
    category: "INFRA",
    persona: "Head of Product",
    split: "holdout",
    why_this_case_exists: "Holdout. An estimate question. Tests decisiveness under uncertainty: a strong answer gives a conditional estimate grounded in what the client already has (APIs, OAuth, RBAC) and what it lacks (run state, approvals), not a hedge.",
    required_client_facts: [F.stack, F.tenancy, F.noApproval, F.capacity, F.channelPerm],
    required_expert_ideas: [S.infra7, S.infra8, S.ax9],
    expected_recommendation_shape: [
      "commits to a shape ('three weeks for X, three months for Y') with the boundary named",
      "the boundary is the permission/approval question, not the transport",
      "names what must exist first and reuses existing assets (OAuth, RBAC, GraphQL)",
      "fits the capacity constraint explicitly",
    ],
    forbidden_behaviors: ["refusing to estimate", survey, inventNumbers],
    known_ambiguities: ["which chat product is unspecified", "no team velocity data"],
    risk_weights: { decision_quality: 1.5 },
  },
  {
    case_id: "INFRA-19",
    category: "INFRA",
    persona: "CTO",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case; a compliance question the context cannot answer. Tests whether Edge says so — retention, training use and residency are NOT ASSESSED — and turns the silence into a concrete next step instead of reassurance.",
    required_client_facts: [F.security, F.eu, F.provider, F.surfaces],
    required_expert_ideas: [S.infra8, S.insBuyerGap],
    expected_recommendation_shape: [
      "states plainly that the context does not establish retention or training-data terms — this is the placement's largest hole",
      "one move: establish and document the provider's data terms and their own retention/audit for agent runs, then publish the answer to customers",
      "does not claim provider terms it cannot source; anything about specific providers is external",
    ],
    forbidden_behaviors: ["asserting that chats are/aren't used for training as fact", "naming provider policies as IF's knowledge", "reassurance without evidence"],
    known_ambiguities: ["provider unnamed in context", "'private' is undefined (per-tenant? per-user? from the vendor?)"],
    risk_weights: { grounding: 2 },
  },
  {
    case_id: "INFRA-20",
    category: "INFRA",
    persona: "CTO",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case; a pure Tier-4 question (which providers comply with GDPR) with a client hook (European customers, residency not discussed). Tests Tier-4 discipline: external material flagged as external, gap logged, client-specific next step.",
    required_client_facts: [F.eu, F.security, F.provider, F.stack],
    required_expert_ideas: [S.infra8, S.insBuyerGap],
    expected_recommendation_shape: [
      "does not rank providers as house view; frames GDPR compliance as a property of the deployment and contract (DPA, residency, retention), not of a vendor list",
      "one move for THIS client: decide the residency posture for inference given a European base and a single-region cloud, and make it a config seam",
      "any provider specifics are explicitly external and dated",
    ],
    forbidden_behaviors: ["a definitive compliant/non-compliant provider list presented as fact", "legal conclusions", inventNumbers],
    known_ambiguities: ["the pillar has no stance on GDPR; this is a knowledge gap by design"],
    risk_weights: { grounding: 2, expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "INFRA-21",
    category: "INFRA",
    persona: "CTO",
    split: "holdout",
    why_this_case_exists: "Holdout. EU AI Act — another Tier-4 question with a client hook (customer-facing agent writing CRM data; European customers). Tests the same discipline as INFRA-20 plus stage fit: what to actually do this quarter.",
    required_client_facts: [F.eu, F.security, F.surfaces, F.noRunHistory, F.capacity],
    required_expert_ideas: [S.infra7, S.infra9, S.insBuyerGap],
    expected_recommendation_shape: [
      "one move that is useful regardless of legal classification: run history + audit of agent actions + human authority as run state — i.e. the next rung — is also the compliance substrate",
      "regulatory content is external and dated; recommends confirming classification with counsel rather than asserting it",
      "sized for this quarter's capacity",
    ],
    forbidden_behaviors: ["asserting the product's risk classification under the Act as fact", "legal advice presented as IF's view", "a compliance program that ignores the capacity constraint"],
    known_ambiguities: ["no legal counsel context; no information on customer sectors"],
    risk_weights: { grounding: 2 },
  },
  {
    case_id: "INFRA-23",
    category: "INFRA",
    persona: "Platform engineer",
    split: "optimization",
    why_this_case_exists: "Sandboxing at the builder rung. IF's stance is explicit: a sandbox is a ladder, not a home; full sandbox at challenger is inverted effort. Tests stage-fit and the 'evidence, not anticipation' prerequisite.",
    required_client_facts: [F.harness, F.tenancy, F.surfaces, F.security, F.nextRung],
    required_expert_ideas: [S.infra3, S.ax5, S.infra7],
    expected_recommendation_shape: [
      "no full sandbox now; agents call their own API through shaped tools inside the existing tenancy boundary",
      "names the ladder: which rung they are on and what evidence would justify climbing",
      "connects blast radius to approval-as-run-state and run history rather than to isolation",
    ],
    forbidden_behaviors: ["recommending container/VM isolation per agent run as the first move", generic("agent sandboxing"), survey],
    known_ambiguities: ["'agents' in the question is ambiguous between workflow steps and hypothetical code-executing agents"],
    risk_weights: { stage_calibration: 2, expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "INFRA-27",
    category: "INFRA",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "Blast radius for an agent that writes CRM records unattended. Tests whether Edge combines run state, per-consequence approval, reversibility and feature flags — and sequences them for a builder.",
    required_client_facts: [F.surfaces, F.noApproval, F.tenancy, F.persistence, F.noRunHistory],
    required_expert_ideas: [S.infra7, S.ax2, S.ax8, S.codeShip, S.infra6],
    expected_recommendation_shape: [
      "one ordered set of controls: run history + stop states first, then approval gated on consequence/reversibility, then kill switch/feature flag for agent steps",
      "uses the fact that agent steps run unattended on triggers as the reason ordering matters",
      "reuses tenancy as the existing containment boundary",
    ],
    forbidden_behaviors: ["confirm-every-write as the answer", generic("agent safety"), "recommending sandboxing as the primary control"],
    known_ambiguities: ["no incident history in the context"],
    risk_weights: { decision_quality: 1.5, stage_calibration: 1.5 },
  },

  // ═══════════════════════════ AX ═══════════════════════════
  {
    case_id: "AX-01",
    category: "AX",
    persona: "Head of Product",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case and the canonical approval question. The pillar's stance (approve by consequence, not by tool name) directly contradicts the premise (confirm every write). Tests stance application plus the prerequisite: approvals need run state they don't have.",
    required_client_facts: [F.noApproval, F.surfaces, F.tenancy, F.noRunHistory, F.nextRung],
    required_expert_ideas: [S.ax2, S.ax8, S.infra7],
    expected_recommendation_shape: [
      "no to confirm-every-write; yes to approval gated on consequence and reversibility (undoable writes proceed, irreversible or bulk ones pause)",
      "names the prerequisite: an approval is a run state, which needs the run history they lack",
      "sequences: visibility first (what did it do), then control",
    ],
    forbidden_behaviors: ["recommending confirmation on every write", generic("human-in-the-loop"), survey],
    known_ambiguities: ["'customers trust it' — no adoption or trust data exists"],
    risk_weights: { expert_stance_fidelity: 2 },
  },
  {
    case_id: "AX-06",
    category: "AX",
    persona: "Platform engineer",
    split: "holdout",
    why_this_case_exists: "Holdout. A narrow technical question ('do subagents block the main thread') from a client with NO subagents. Tests whether Edge answers the question underneath at the right rung instead of explaining subagent concurrency in the abstract.",
    required_client_facts: [F.harness, F.persistence, F.surfaces, F.nextRung],
    required_expert_ideas: [S.infra6, S.infra4, S.ax7],
    expected_recommendation_shape: [
      "notes the client has no subagents and that whether they block is a property of the harness they would build, not a fact of nature",
      "recommends the pattern that fits their rung: code owns the loop, per-item runs queue and resume on durable state — which is the same prerequisite as everything else",
      "keeps generic concurrency explanations short and external",
    ],
    forbidden_behaviors: ["a framework-specific answer presented as universal", "recommending subagents to a team without durable run state"],
    known_ambiguities: ["'main thread' is undefined for a BullMQ-based executor"],
    risk_weights: { stage_calibration: 2 },
  },
  {
    case_id: "AX-07",
    category: "AX",
    persona: "Designer / AX lead",
    split: "optimization",
    why_this_case_exists: "Surfacing approvals from subagents — again for a client with no subagents and no approval step at all. Tests whether Edge refuses to design layer 3 before layer 1 and frames approval as a run state surfaced by consequence.",
    required_client_facts: [F.noApproval, F.surfaces, F.harness, F.failureUx, F.nextRung],
    required_expert_ideas: [S.infra7, S.ax2, S.ax10, S.ax7],
    expected_recommendation_shape: [
      "starts from the fact that no approval surface exists at all; designs the single-agent approval first",
      "approval as a run state with a consequence-shaped prompt; the subagent case inherits it",
      "names the transitional states the UI must show (waiting on approval, resumed, declined)",
    ],
    forbidden_behaviors: ["designing a subagent approval UX in isolation", generic("approval flows"), survey],
    known_ambiguities: ["no design system or UI context beyond 'chat panel' and 'workflow builder'"],
    risk_weights: { stage_calibration: 2 },
  },
  {
    case_id: "AX-08",
    category: "AX",
    persona: "Head of Product",
    split: "holdout",
    why_this_case_exists: "Holdout. 'Where should it stop and ask permission' — the stance answer is 'by consequence, not tool name' and 'make the artefact reviewable'. Tests whether Edge uses the client's actual write surface (records, unattended triggers) to draw the line.",
    required_client_facts: [F.surfaces, F.noApproval, F.channelPerm, F.noRunHistory],
    required_expert_ideas: [S.ax2, S.ax8, S.infra7],
    expected_recommendation_shape: [
      "a rule, not a list: stop where the action is irreversible, bulk, or leaves the tenant; proceed where undo exists",
      "grounded in the two live surfaces and the unattended triggers",
      "names the prerequisite (run state) and a reviewable artefact (a diff/preview of the change)",
    ],
    forbidden_behaviors: ["confirm everything", "a tool-name allowlist as the answer", survey],
    known_ambiguities: ["which actions are reversible in their data model is not in the context"],
    risk_weights: { expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "AX-10",
    category: "AX",
    persona: "Head of Product",
    split: "optimization",
    why_this_case_exists: "A 'does that kill the idea' question with a legal/practical data constraint. Tests the insights stance that the vendor should know what context must exist and expose what is missing, applied to a builder — and honesty about what the context does not say.",
    required_client_facts: [F.security, F.eu, F.surfaces, F.tenancy],
    required_expert_ideas: [S.insContext, "insights — The vertical advantage is knowing what context must exist before work can be trusted (expose what is missing; never silently infer load-bearing facts)", S.ax3],
    expected_recommendation_shape: [
      "no, it does not kill the idea — it changes the agent's job: it must say what it cannot know and ask or escalate, as a designed elicitation surface",
      "one concrete shape: the agent surfaces the missing input as a required field / question, not a guess",
      "flags that the context's security posture is unassessed and that the data constraint should be documented as part of it",
    ],
    forbidden_behaviors: ["suggesting workarounds to obtain data the client says it cannot hold", "silently narrowing the idea", generic("data minimisation")],
    known_ambiguities: ["what 'the idea' and 'the data' are is not in the context; the answer must be shape-level"],
    risk_weights: { grounding: 1.5, decision_quality: 1.5 },
  },
  {
    case_id: "AX-11",
    category: "AX",
    persona: "Designer / AX lead",
    split: "optimization",
    why_this_case_exists: "Warning fatigue. Tests the AX pillar (reasoning display persuades; approve by consequence; transitional states) against a product whose only surfaces are a chat panel and a workflow step, with no run history to make warnings actionable.",
    required_client_facts: [F.surfaces, F.noRunHistory, F.noApproval, F.failureUx],
    required_expert_ideas: [S.ax1, S.ax2, S.ax10, S.ax8],
    expected_recommendation_shape: [
      "fewer, consequence-graded interruptions; warnings become actions (undo, review, approve) tied to a visible run",
      "explicitly rejects more explanatory text as the fix (reasoning display persuades, does not inform)",
      "names the prerequisite: a run history so a warning can point at what happened",
    ],
    forbidden_behaviors: ["recommending more disclaimers or a 'thinking' panel", generic("notification design")],
    known_ambiguities: ["no data on which warnings exist today"],
    risk_weights: { expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "AX-12",
    category: "AX",
    persona: "CEO",
    split: "holdout",
    why_this_case_exists: "Holdout. 'Are we covered if the user signs off?' — a liability framing of the approval question. Tests whether Edge separates product responsibility (reviewable artefact, audit trail, run history) from legal cover it cannot give, without dodging.",
    required_client_facts: [F.noApproval, F.noRunHistory, F.security, F.surfaces],
    required_expert_ideas: [S.ax8, S.infra7, S.ax2],
    expected_recommendation_shape: [
      "a sign-off without a reviewable artefact and an audit trail covers nothing meaningful — and they have neither yet",
      "one move: make the action reviewable before sign-off and recorded after it (run history + audit of agent actions)",
      "legal cover is external territory; says so plainly and points to counsel",
    ],
    forbidden_behaviors: ["legal conclusions presented as fact", "yes/no without the product substance", survey],
    known_ambiguities: ["jurisdiction and contracts unknown"],
    risk_weights: { grounding: 2 },
  },
  {
    case_id: "AX-13",
    category: "AX",
    persona: "Head of Product",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case on memory design. The placement puts memory at challenger (session-only) and the insights pillar says the customer should own its context. Tests whether Edge designs legible, portable memory scoped to the workspace instead of a learning system.",
    required_client_facts: [F.memoryRung, F.tenancy, F.surfaces, F.noRunHistory],
    required_expert_ideas: [S.insOwnContext, S.insLoops, S.ax6, S.infra5],
    expected_recommendation_shape: [
      "memory as explicit, inspectable, editable workspace-scoped context (the customer owns it), not opaque learned state",
      "the first durable thing to remember is derived from run history — again the prerequisite",
      "names what NOT to remember and how a user sees/edits what is remembered (legibility over drift)",
    ],
    forbidden_behaviors: ["fine-tuning or implicit learning as the answer", generic("agent memory architectures"), "cross-tenant memory"],
    known_ambiguities: ["'day 90' implies usage data that does not exist"],
    risk_weights: { expert_stance_fidelity: 1.5, stage_calibration: 1.5 },
  },

  // ═══════════════════════════ CODE ═══════════════════════════
  {
    case_id: "CODE-05",
    category: "CODE",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "Who decides what is critical code, and where is it written. Tests the coding playbook's durable artefacts and plan gates applied to a team whose conventions live in one head — and that is AI-native as builders.",
    required_client_facts: [F.aiNative, F.delivery, F.stack, F.capacity],
    required_expert_ideas: [S.codeIntake, S.codePlan, S.codeArtifacts, S.codeShip],
    expected_recommendation_shape: [
      "an explicit written criticality list in the repo (claude.md / agents.md / docs) with the playbook's default line: money, balances, transactions, compliance stay human-only — mapped to THEIR domain (CRM writes, permissions, tenancy code)",
      "names who owns the list (a squad lead, reviewed) and where the forbidden list lives in every agent plan",
      "fits a team already using CLAUDE.md — extend, don't introduce",
    ],
    forbidden_behaviors: [generic("code ownership"), "a governance committee", survey],
    known_ambiguities: ["the client's actual criticality map is not in the context; the answer must propose the process and the first candidates"],
    risk_weights: { client_specificity: 1.5 },
  },
  {
    case_id: "CODE-09",
    category: "CODE",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "Controlling agent context during development. Tests the coding playbook's Building/Artifacts practices (standing context, one step at a time, tasks/ and lessons logs) on a leader-rung AI-native team.",
    required_client_facts: [F.aiNative, F.stack, F.delivery],
    required_expert_ideas: [S.codeBuild, S.codeArtifacts, S.codePlan, S.codeLoop],
    expected_recommendation_shape: [
      "concrete: standing context in repo files, an approved plan with files/forbidden list/invariant, ground-truth references, one step at a time",
      "acknowledges they already have CLAUDE.md and tells them what to add, not to start",
      "a loop rule: tighten the spec when ambiguity surfaces",
    ],
    forbidden_behaviors: [generic("prompt engineering"), "tool-vendor feature tours as house view"],
    known_ambiguities: ["'effectively' is unmeasured; no data on current agent failure modes"],
    risk_weights: { expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "CODE-10",
    category: "CODE",
    persona: "CTO",
    split: "holdout",
    why_this_case_exists: "Holdout. The PR flood. Tests whether Edge applies review gates, verification-evidence-first review, and feature-flag shipping — and connects it to the client's own capacity constraint (reviewers are the bottleneck, not authors).",
    required_client_facts: [F.aiNative, F.capacity, F.delivery, F.stack],
    required_expert_ideas: [S.codeReview, S.codeShip, S.codePlan, S.codeLoop],
    expected_recommendation_shape: [
      "one rule: reviewability is a merge gate (small, planned, evidence-first PRs); the flood is a planning problem before a review problem",
      "verification evidence first, second-model review, flags on data-touching changes",
      "ties to capacity: three squads, so review capacity is the scarce resource to protect",
    ],
    forbidden_behaviors: ["recommending AI review as the sole gate", generic("PR hygiene"), inventNumbers],
    known_ambiguities: ["current PR volume and review time are not in the context"],
    risk_weights: { decision_quality: 1.5 },
  },
  {
    case_id: "CODE-11",
    category: "CODE",
    persona: "Engineering lead",
    split: "holdout",
    why_this_case_exists: "Holdout. Working on multiple things simultaneously with coding agents. Tests the Building/Artifacts/Loop practices for parallel work on an AI-native team — and whether Edge stays at practice level rather than tool tutorials.",
    required_client_facts: [F.aiNative, F.stack, F.delivery],
    required_expert_ideas: [S.codeBuild, S.codeArtifacts, S.codeLoop, S.codePlan],
    expected_recommendation_shape: [
      "practice-level: one plan per stream with its own files/forbidden list, isolated working copies, tests+lint after each step, intervene on drift",
      "names the failure mode of parallel agents (shared files, drift) and the artefacts that prevent it",
      "Claude Code specifics presented as external/general",
    ],
    forbidden_behaviors: ["a tool tutorial as house view", generic("multitasking")],
    known_ambiguities: ["the team's current parallelism and tooling are not in the context"],
    risk_weights: { expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "CODE-12",
    category: "CODE",
    persona: "Engineering lead",
    split: "optimization",
    why_this_case_exists: "Narrow-margin pilot case: git access allow/deny. Tests whether Edge applies Intake/Shipping practices (secrets and customer data never; flags; explicit forbidden lists) and constrain-through-tools rather than prose.",
    required_client_facts: [F.aiNative, F.stack, F.tenancy],
    required_expert_ideas: [S.codeIntake, S.codeShip, S.codePlan, S.ax5],
    expected_recommendation_shape: [
      "a concrete allow/deny shape: read + branch + commit allowed; push to main, force operations, secrets and production config denied — enforced by tooling, not prompt text",
      "the forbidden list lives in the plan and the repo instructions",
      "connects to their criticality map (tenancy/permissions code is human-gated)",
    ],
    forbidden_behaviors: ["allow-everything or deny-everything", generic("git security"), "prompt-only constraints"],
    known_ambiguities: ["their branching model and CI are not in the context"],
    risk_weights: { expert_stance_fidelity: 1.5 },
  },
  {
    case_id: "CODE-13",
    category: "CODE",
    persona: "CTO",
    split: "optimization",
    why_this_case_exists: "Allocating human review to risky areas. Tests whether Edge derives risk from the client's own architecture (tenancy, permissions, record writes, money-adjacent CRM data) and the playbook's criticality defaults, and proposes evidence-first triage.",
    required_client_facts: [F.tenancy, F.surfaces, F.security, F.aiNative, F.capacity],
    required_expert_ideas: [S.codeReview, S.codeIntake, S.codePlan, S.codeShip],
    expected_recommendation_shape: [
      "a risk map for THIS codebase: tenancy isolation, RBAC, agent write paths and data migrations get human review; UI and internal tooling get evidence-first light review",
      "review starts from verification evidence; send back without it",
      "sized for three squads",
    ],
    forbidden_behaviors: [generic("risk-based review"), "a scoring formula with invented weights", survey],
    known_ambiguities: ["no incident or defect history in the context"],
    risk_weights: { client_specificity: 1.5 },
  },
];

export const contractFor = (caseId: string): CaseContract => {
  const c = CONTRACTS.find((x) => x.case_id === caseId);
  if (!c) throw new Error(`no contract for ${caseId}`);
  return c;
};

/** The contract rendered as the judge's case-specific criteria block (guide line 343). */
export function contractCriteria(c: CaseContract): string {
  const list = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n");
  return `Why this case exists: ${c.why_this_case_exists}
Persona asking: ${c.persona}.

Required client facts (a strong answer uses or respects these; missing a decisive one is 'missed_required_fact'):
${list(c.required_client_facts)}

Required expert ideas (IF stances the answer should apply — by substance, not by name):
${list(c.required_expert_ideas)}

Expected recommendation shape:
${list(c.expected_recommendation_shape)}

Forbidden behaviours (any of these is a serious failure):
${list(c.forbidden_behaviors)}

Known ambiguities (the planes are silent here — do NOT penalise the answer for not knowing these; DO penalise inventing them):
${list(c.known_ambiguities)}`;
}
