import type { DynamicAgentStore, PurgeResult } from "@intentface/latch-core";
import type { AgentRecord, AgentScope } from "./record.js";

/**
 * The store seam for agent records.
 *
 * The record SHAPE lives in `./record` (one zod schema → type, validator,
 * tool input, editor form). Storage is host-supplied: `@intentface/latch-drizzle`
 * ships an implementation. The store doubles as a `DynamicAgentStore` so saved
 * records are runnable by the host's runtime — `resolve` builds the same
 * `AgentConfig` a code-declared agent would.
 */

export type { AgentRecord, AgentScope, AttachedEval, AgentRecordInput } from "./record.js";
export { isCandidateId, normalizeAgentName, parseAgentRef } from "./record.js";
export type { AgentRefAt } from "./record.js";

/** How a version came to be published — provenance only, never behaviour. */
export type AgentPublishSource = "editor" | "builder-agent" | "api" | "backfill";

/** Options carried by a publish, for the history row. */
export interface AgentPublishOptions {
  /** Host-supplied publisher id (e.g. a user id). Shown in history. */
  author?: string;
  /** Defaults to "api" — the seam has no way to guess the caller. */
  source?: AgentPublishSource;
  /**
   * Optional one-line note shown in history. Trimmed; blank becomes absent.
   * Not truncated here — callers should bound it (the platform caps at 500).
   */
  message?: string;
}

/**
 * One row of an agent's publish history. Metadata only: the record itself can
 * be large, and a history list never needs it (`getVersion` fetches one).
 */
export interface AgentVersionMeta {
  version: number;
  author?: string;
  source?: AgentPublishSource;
  message?: string;
  /**
   * Top-level record fields that differ from the PREVIOUS version — enough for a
   * history list to read "instructions, model" without fetching two snapshots.
   * Absent on v1, which has nothing to differ from.
   */
  changedFields?: string[];
  createdAt: number;
  /** True for the version the live record is currently a copy of. */
  published: boolean;
}

/** How a version came to be live. */
export type AgentActivationSource = "publish" | "activate" | "backfill";

/** One entry in the publish timeline: a version became live. */
export interface AgentActivation {
  version: number;
  /** Host-supplied actor id; absent for the migration backfill. */
  actor?: string;
  source?: AgentActivationSource;
  createdAt: number;
}

/** An in-progress, unpublished edit. Never affects a running agent. */
export interface AgentDraft {
  record: AgentRecord;
  /**
   * The version this draft was started from. Compare against the live
   * `publishedVersion` before publishing: if they differ, someone else has
   * published since and publishing blind would silently revert them.
   */
  baseVersion?: number;
  updatedAt: number;
}

/**
 * A named, unpublished configuration of an agent. Unlike a draft it belongs to
 * the AGENT, not to one person: everyone who can edit the agent sees it, runs
 * it as `name@c_<id>`, and may publish it. Closing keeps it — discarded, or
 * published as a version — so anything filed under it keeps its name.
 */
export interface AgentCandidate {
  /** `c_…`, stable across renames. */
  id: `c_${string}`;
  title: string;
  record: AgentRecord;
  /** The version it was started from — the same publish guard as a draft's. */
  baseVersion?: number;
  /** Host editor key of whoever created it. */
  author?: string;
  /** The version it became, once published. */
  publishedAs?: number;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** A draft's existence and ownership, without its content. */
export interface AgentDraftSummary {
  name: string;
  scope: AgentScope;
  /** True when the caller owns it; false means a colleague is mid-edit. */
  mine: boolean;
  updatedAt: number;
}

/**
 * The storage seam the builder writes through. Extends `DynamicAgentStore` so
 * one object serves both duties: record CRUD for the builder/editor, and
 * list/resolve for the runtime's dynamic-agent registry.
 */
export interface AgentBuilderStore<P> extends DynamicAgentStore<P> {
  /** Full records visible to the caller (org + personal), for the builder/editor. */
  listRecords: (p: P) => Promise<AgentRecord[]>;
  /**
   * One record by name — personal wins over org on a clash, unless the name is
   * pinned with an `org:`/`user:` prefix (see `parseAgentRef`), which is how
   * channel bindings and run records refer to an agent.
   */
  getRecord: (p: P, name: string) => Promise<AgentRecord | undefined>;
  /**
   * Create or update by (owner, name), and PUBLISH: the record becomes live for
   * the next turn and is appended to the agent's version history. Callers pass a
   * NORMALIZED record (`normalizeAgentRecord`).
   *
   * Publishing a record identical to the current version appends nothing — the
   * history stays a list of real changes. `opts` only decorates the history row.
   */
  upsert: (p: P, rec: AgentRecord, opts?: AgentPublishOptions) => Promise<void>;
  /** Delete the agent, its version history and (host tables aside) its drafts. */
  remove: (p: P, scope: AgentScope, name: string) => Promise<void>;
  /**
   * Publish history for one agent, newest first. Empty for an agent that has
   * never been published through this store (e.g. rows written before
   * versioning, if the backfill has not run).
   */
  listVersions: (p: P, name: string, scope: AgentScope) => Promise<AgentVersionMeta[]>;
  /** The full record as published at one version, for preview, diff or restore. */
  getVersion: (p: P, name: string, scope: AgentScope, version: number) => Promise<AgentRecord | undefined>;
  /**
   * Make an EXISTING version live — rollback. Moves the published pointer and
   * copies that version's record into the live row; it does NOT append a
   * version, so history stays a list of distinct configurations rather than
   * growing a duplicate every time someone flips between two of them. Nothing
   * is lost: every version between the two remains, and the move is reversible.
   *
   * Distinct from `upsert`, which publishes NEW content. "Restore an old version
   * and edit it before shipping" is the host's job: `getVersion` into a draft,
   * then `upsert` when the user is ready.
   */
  activateVersion: (
    p: P,
    name: string,
    scope: AgentScope,
    version: number,
    opts?: { actor?: string },
  ) => Promise<void>;
  /**
   * The publish timeline, newest first: which version became live, when, and by
   * whom. Distinct from `listVersions`, which is the set of distinct
   * CONFIGURATIONS — activating an old version appends no version, so only this
   * records that it happened.
   */
  listActivations: (
    p: P,
    name: string,
    scope: AgentScope,
    limit?: number,
  ) => Promise<AgentActivation[]>;

  /** The CALLER's unpublished working copy, if any. */
  getDraft: (p: P, name: string, scope: AgentScope) => Promise<AgentDraft | undefined>;
  /** Create or replace the caller's working copy. Never touches the live record. */
  saveDraft: (
    p: P,
    name: string,
    scope: AgentScope,
    rec: AgentRecord,
    baseVersion?: number,
  ) => Promise<void>;
  /** Drop the caller's working copy (discarded, or published and no longer needed). */
  discardDraft: (p: P, name: string, scope: AgentScope) => Promise<void>;
  /**
   * Every draft under the caller's visible owners — theirs and colleagues' — for
   * the agent list's "unpublished draft" badge and the editor's "someone else is
   * editing this" banner. Metadata only; a colleague's in-progress text is not
   * the caller's to read.
   */
  listDrafts: (p: P) => Promise<AgentDraftSummary[]>;

  /** The agent's candidates, newest first; closed ones only when asked. */
  listCandidates: (
    p: P,
    name: string,
    scope: AgentScope,
    opts?: { closed?: boolean },
  ) => Promise<AgentCandidate[]>;
  /** One candidate by id, open or closed. */
  getCandidate: (p: P, name: string, scope: AgentScope, id: string) => Promise<AgentCandidate | undefined>;
  /**
   * Create (no `id`) or update one. Never touches the live record. Returns the
   * saved candidate. Updating a closed candidate is refused: what was
   * published or discarded stays as it was.
   */
  saveCandidate: (
    p: P,
    name: string,
    scope: AgentScope,
    c: { id?: string; title: string; record: AgentRecord; baseVersion?: number },
  ) => Promise<AgentCandidate>;
  /** Close it — discarded, or published as `publishedAs`. It still resolves. */
  closeCandidate: (
    p: P,
    name: string,
    scope: AgentScope,
    id: string,
    opts?: { publishedAs?: number },
  ) => Promise<void>;
  /**
   * For background jobs only, across every customer: the names of agents that
   * may have memory switched on. A quick filter, not an answer: check each one
   * again with `getRecord` as the chat's own principal before acting on it.
   */
  listMemoryEnabledNames: () => Promise<string[]>;
  /**
   * OPTIONAL. Delete everything this store keeps (agents, versions, activations, candidates, and the drafts a person is writing) for an owner path, in passes
   * (see `StorageAdapter.purgeOwner`): call until `done`. Without it,
   * `runtime.purgeOwner` refuses when this store is passed to it.
   */
  purgeOwner?(segments: string[], opts?: { batchSize?: number }): Promise<PurgeResult>;
}
