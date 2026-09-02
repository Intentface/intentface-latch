import type {
  AgentBuilderStore,
  AgentRecord as PkgAgentRecord,
  AttachedEval as PkgAttachedEval,
} from "@intentface/latch-agent-builder";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";
import type { EvalTrigger } from "./observability/trigger";

/**
 * UI-created agents live in `latch_agents`, owned by the framework:
 * `@intentface/latch-agent-builder` defines the record (one zod schema →
 * type, validator, builder input, editor form) and `@intentface/latch-drizzle`
 * stores it. What stays here is the platform's OWNER-KEY policy — how a
 * Principal + scope maps to the row's `owner` column — because that key
 * doubles as the eval-visibility boundary.
 */

export { normalizeAgentName, parseAgentRef } from "@intentface/latch-agent-builder";
export type { AgentRecord, AgentScope } from "@intentface/latch-agent-builder";

/** The store the runtime and every server fn use (drizzle-backed, see lib/latch.ts). */
export type AgentStore = AgentBuilderStore<Principal>;

/**
 * The platform's rubric: the package keeps `trigger` opaque (a host-defined
 * predicate); here it is the observability layer's `EvalTrigger`. Every write
 * path runs `validateRubrics` (observability/rubrics.ts), which validates the
 * trigger AST — so narrowing a stored record's rubrics is safe.
 */
export type AttachedEval = Omit<PkgAttachedEval, "trigger"> & { trigger?: EvalTrigger };

/** A stored record's rubrics, narrowed to the platform type (see `AttachedEval`). */
export const rubricsOf = (rec: Pick<PkgAgentRecord, "attachedEvals"> | undefined): AttachedEval[] =>
  (rec?.attachedEvals ?? []) as AttachedEval[];

/**
 * The `latch_agents.owner` key for a principal at a given scope: `org` → the org
 * alone (shared with every member), `user` → the (org, user) pair. The same
 * derivation is handed to the drizzle store as its `owner` option (as
 * segments), so this function and the store can never disagree.
 */
export const agentOwnerSegments = (p: Principal, scope: CredentialScope): string[] =>
  scope === "org" ? [p.orgId] : [p.orgId, p.userId ?? ""];

const ownerKey = (p: Principal, scope: CredentialScope): string =>
  agentOwnerSegments(p, scope).map(encodeURIComponent).join("/");

export { ownerKey as agentOwnerKey };

/**
 * The eval owner of an agent a caller resolved: the `owner` column of that row.
 *
 * Derived rather than read back, and safely so — the store only ever matches
 * rows whose owner is one of the caller's OWN keys, and `upsert` always writes
 * `owner = ownerKey(principal, scope)`. So for any record this caller could
 * resolve, the row's owner and `ownerKey(caller, record.scope)` are the same
 * string by construction. Deriving keeps the owner key off `AgentRecord`, which
 * is passed wholesale to the model by `get_agent` and to the browser by
 * `listAgentRecordsFn`.
 */
export const evalOwnerOfRecord = (p: Principal, rec: { scope: CredentialScope }): string =>
  ownerKey(p, rec.scope);

/**
 * The owner keys whose agents this principal may administer, i.e. the eval
 * verdicts it may see: its personal key and its org's shared key. The judge
 * files each verdict under the resolved agent's own owner key, so reading with
 * these two is exactly "the evals of agents I could edit" — a user who merely
 * *runs* someone else's agent matches neither and sees nothing.
 *
 * Ordered personal-first to mirror the store's personal-wins-over-org precedence.
 */
export const evalOwnerKeysOf = (p: Principal): string[] => [ownerKey(p, "user"), ownerKey(p, "org")];
