import type { DynamicAgentStore } from "@intentface/latch-core";
import type { AgentRecord, AgentScope } from "./record";

/**
 * The store seam for agent records.
 *
 * The record SHAPE lives in `./record` (one zod schema → type, validator,
 * tool input, editor form). Storage is host-supplied: `@intentface/latch-drizzle`
 * ships an implementation. The store doubles as a `DynamicAgentStore` so saved
 * records are runnable by the host's runtime — `resolve` builds the same
 * `AgentConfig` a code-declared agent would.
 */

export type { AgentRecord, AgentScope, AttachedEval, AgentRecordInput } from "./record";
export { normalizeAgentName, parseAgentRef } from "./record";

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
  /** Create or update by (owner, name). Callers pass a NORMALIZED record (`normalizeAgentRecord`). */
  upsert: (p: P, rec: AgentRecord) => Promise<void>;
  remove: (p: P, scope: AgentScope, name: string) => Promise<void>;
  /**
   * SYSTEM op (principal-free, cross-tenant): distinct names of records that
   * look memory-enabled — a cheap prefilter for a background memory sweep. The
   * sweep must re-check each candidate authoritatively (via `getRecord` under
   * the chat's own principal); false positives here are harmless, and results
   * must never feed anything but that per-principal check.
   */
  listMemoryEnabledNames: () => Promise<string[]>;
}
