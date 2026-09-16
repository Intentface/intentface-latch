import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { desc, eq, inArray, and, like, sql } from "drizzle-orm";
import type { LanguageModel } from "ai";
import type { AgentConfig, AgentInfo } from "@intentface/latch-core";
import { parseAgentRef } from "@intentface/latch-agent-builder";
import type {
  AgentActivation,
  AgentBuilderStore,
  AgentDraft,
  AgentDraftSummary,
  AgentPublishOptions,
  AgentRecord,
  AgentScope,
  AgentVersionMeta,
} from "@intentface/latch-agent-builder";
import { isUniqueViolation } from "./adapter.shared.js";
import * as sqliteSchema from "./schema.js";
import * as pgSchema from "./schema.pg.js";

/**
 * `AgentBuilderStore` on Drizzle — the persistence + dynamic-agent view for
 * builder/editor-created agents (`latch_agents`). One shared core over a tiny
 * query seam; SQLite and Postgres wrappers below.
 */

function newId(): string {
  return `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function newVersionId(): string {
  return `agv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function newActivationId(): string {
  return `aga_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * How many times a publish retries when a concurrent one takes its number.
 *
 * Each contended round lets exactly one writer through, so a loser may need as
 * many attempts as there are concurrent publishers. Real contention here is a
 * couple of humans clicking Publish, so this is far above what can be reached —
 * it exists only so the loop is bounded rather than as a tuned value.
 */
const PUBLISH_ATTEMPTS = 20;

/**
 * Jittered pause between publish retries. Without it, losers re-read and re-try
 * in lockstep and collide again; a few random milliseconds desynchronises them.
 */
const publishBackoff = (): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));

/**
 * Stable JSON for EQUALITY ONLY (never for storage): object keys sorted at every
 * depth, and absent/null/empty-array treated alike.
 *
 * That last part is what makes "publishing an unchanged record appends nothing"
 * actually hold. The same record reaches this function in three spellings — a
 * caller's `AgentRecord` (absent keys are `undefined`), a row round-tripped
 * through the live table (empty arrays are stored `null`), and the migration's
 * backfilled v1 (built by `json_object`, so every absent column is an explicit
 * `null`). Without flattening those, a no-op publish right after the backfill
 * would append a duplicate version.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

const canonical = (rec: AgentRecord): string => JSON.stringify(canonicalize(rec));

/**
 * Which top-level record fields differ between two versions. Compared through
 * `canonicalize`, so the same spelling rules that decide "did anything change at
 * all" also decide "which field changed" — otherwise a record could publish
 * (unchanged overall) yet report fields as changed, or vice versa.
 *
 * `undefined` for the first version: there is nothing to have changed from.
 */
function changedFieldsBetween(
  prev: AgentRecord | undefined,
  next: AgentRecord,
): string[] | undefined {
  if (!prev) return undefined;
  const a = canonicalize(prev) as Record<string, unknown>;
  const b = canonicalize(next) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return fields.length ? fields : undefined;
}

/**
 * A stored version payload back into an `AgentRecord`. Nulls become absent
 * (see `canonicalize`) so a backfilled row and a published one round-trip to
 * the same record. JSON columns arrive parsed from both dialects; a string is
 * tolerated for hosts whose driver hands back raw text.
 */
function recordFromJson(value: unknown): AgentRecord {
  const raw = (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(raw ?? {})) {
    if (v === null || v === undefined) continue;
    out[key] = v;
  }
  if (!Array.isArray(out.connections)) out.connections = [];
  return out as unknown as AgentRecord;
}

export interface AgentStoreOptions<P> {
  /**
   * Derive the ownership key segments for a principal at a scope — the
   * isolation boundary (e.g. platform: org → [orgId], user → [orgId, userId];
   * a workspace-per-DB host: org → ["workspace"], user → [userId]). Must be
   * server-derived from the authenticated principal, never client input.
   */
  owner: (principal: P, scope: AgentScope) => string[];
  /** Resolve a stored model id to the executable model (host catalog). */
  modelFor: (id: string) => LanguageModel;
  /**
   * Resolve the named authored tools into executable tools for a caller —
   * supplied by hosts with a tool-authoring feature. When omitted, an agent's
   * `authoredTools` are simply not attached.
   */
  loadAuthoredTools?: (
    principal: P,
    names: string[],
    agentScope: AgentScope,
  ) => Promise<Record<string, unknown>>;
  /**
   * Decorate the resolved `AgentConfig` with host policy, with the matched
   * RECORD in hand (resolve alone hides it) — e.g. default a baseline
   * toolset, or gate/waive tool approvals off `exec` flags. Runs last;
   * return the (mutated or replaced) config.
   */
  decorateResolve?: (
    cfg: AgentConfig<P>,
    record: AgentRecord,
    principal: P,
  ) => AgentConfig<P>;
  /**
   * Identify the EDITOR — a person — for per-user drafts and for attributing a
   * publish. Distinct from `owner`, which is an isolation boundary a whole org
   * shares: keying drafts by owner would let two admins of the same org
   * overwrite each other's half-written prompt.
   *
   * Defaults to the user-scope owner key, which is already per-person on any
   * host whose user scope includes a user id (the platform's is `orgId/userId`).
   */
  editorKey?: (principal: P) => string;
}

/** A stored row, dialect-agnostic (JSON columns arrive parsed from both dialects). */
interface AgentRow {
  owner: string;
  name: string;
  title: string | null;
  description: string | null;
  modelId: string;
  instructions: string;
  connections: unknown;
  tools: unknown;
  exec: unknown;
  subagents: unknown;
  attachedEvals: unknown;
  maxSteps: number | null;
  scope: string;
  publishedVersion: number | null;
}

/** A stored version row, dialect-agnostic. */
interface AgentVersionRow {
  version: number;
  record: unknown;
  author: string | null;
  source: string | null;
  changedFields: unknown;
  changeMessage: string | null;
  createdAt: number;
}

interface AgentActivationRow {
  version: number;
  actor: string | null;
  source: string | null;
  createdAt: number;
}

interface AgentDraftRow {
  name: string;
  owner: string;
  editor: string;
  record: unknown;
  baseVersion: number | null;
  updatedAt: number;
}

/** The dialect seam: a few queries + one upsert. */
interface AgentQueries {
  /** Rows for these owners, optionally one name only (filtered at the query, not in memory). */
  byOwners(owners: string[], name?: string): Promise<AgentRow[]>;
  /** Distinct names whose `exec` JSON mentions memory — cross-tenant prefilter. */
  memoryEnabledNames(): Promise<string[]>;
  upsert(row: {
    id: string;
    owner: string;
    rec: AgentRecord;
    maxSteps: number | null;
    now: number;
    publishedVersion: number;
  }): Promise<void>;
  remove(owner: string, name: string): Promise<void>;
  /** Version rows newest-first; `limit` trims to the head. */
  versions(owner: string, name: string, limit?: number): Promise<AgentVersionRow[]>;
  versionAt(owner: string, name: string, version: number): Promise<AgentVersionRow | undefined>;
  /** Append one version. Rejects on (owner, name, version) collision. */
  insertVersion(row: {
    id: string;
    owner: string;
    name: string;
    version: number;
    rec: AgentRecord;
    author: string | null;
    source: string;
    changedFields: string[] | null;
    changeMessage: string | null;
    now: number;
  }): Promise<void>;
  removeVersions(owner: string, name: string): Promise<void>;
  insertActivation(row: {
    id: string;
    owner: string;
    name: string;
    version: number;
    actor: string | null;
    source: string;
    now: number;
  }): Promise<void>;
  activations(owner: string, name: string, limit?: number): Promise<AgentActivationRow[]>;
  removeActivations(owner: string, name: string): Promise<void>;
  draft(owner: string, name: string, editor: string): Promise<AgentDraftRow | undefined>;
  upsertDraft(row: {
    owner: string;
    name: string;
    editor: string;
    rec: AgentRecord;
    baseVersion: number | null;
    now: number;
  }): Promise<void>;
  removeDraft(owner: string, name: string, editor: string): Promise<void>;
  /** Every draft under these owners (all editors) — metadata for badges. */
  draftsByOwners(owners: string[]): Promise<AgentDraftRow[]>;
  removeDrafts(owner: string, name: string): Promise<void>;
}

/** Column value (INTEGER) ↔ AgentRecord.maxSteps: NULL=default, 0=unlimited, N=cap. */
const maxStepsToCol = (m: AgentRecord["maxSteps"]): number | null =>
  m === "unlimited" ? 0 : typeof m === "number" ? m : null;
const maxStepsFromCol = (v: number | null): AgentRecord["maxSteps"] =>
  v == null ? undefined : v === 0 ? "unlimited" : v;

const ownerKeyOf = (segments: string[]): string => segments.map(encodeURIComponent).join("/");

function createStore<P>(queries: AgentQueries, opts: AgentStoreOptions<P>): AgentBuilderStore<P> {
  const ownerKey = (p: P, scope: AgentScope) => ownerKeyOf(opts.owner(p, scope));
  // The user-scope owner key is already per-person wherever the host's user
  // scope carries a user id, so it is the right default editor identity.
  const editorKey = (p: P) => opts.editorKey?.(p) ?? ownerKeyOf(opts.owner(p, "user"));

  const recordOf = (row: AgentRow): AgentRecord => ({
    name: row.name,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    modelId: row.modelId,
    instructions: row.instructions,
    connections: (row.connections ?? []) as string[],
    maxSteps: maxStepsFromCol(row.maxSteps),
    tools: (row.tools ?? undefined) as AgentRecord["tools"],
    exec: (row.exec ?? undefined) as AgentRecord["exec"],
    subagents: (row.subagents ?? undefined) as string[] | undefined,
    attachedEvals: (row.attachedEvals ?? undefined) as AgentRecord["attachedEvals"],
    scope: row.scope as AgentScope,
  });

  /** The matched ROW, for callers that need more than the record (see `resolve`). */
  async function findRow(p: P, name: string, scope?: AgentScope): Promise<AgentRow | undefined> {
    // Personal wins over org on a name clash — unless pinned to one scope.
    const owners =
      scope === "org"
        ? [ownerKey(p, "org")]
        : scope === "user"
          ? [ownerKey(p, "user")]
          : [ownerKey(p, "user"), ownerKey(p, "org")];
    const rows = await queries.byOwners(owners, name);
    const personal = rows.find((r) => r.owner === ownerKey(p, "user"));
    return personal ?? rows[0];
  }

  async function find(p: P, name: string, scope?: AgentScope): Promise<AgentRecord | undefined> {
    // Personal wins over org on a name clash — unless pinned to one scope.
    const owners =
      scope === "org"
        ? [ownerKey(p, "org")]
        : scope === "user"
          ? [ownerKey(p, "user")]
          : [ownerKey(p, "user"), ownerKey(p, "org")];
    const rows = await queries.byOwners(owners, name);
    const personal = rows.find((r) => r.owner === ownerKey(p, "user"));
    const row = personal ?? rows[0];
    return row ? recordOf(row) : undefined;
  }

  return {
    async resolve(name, principal): Promise<AgentConfig<P> | undefined> {
      // Channel bindings pin resolution to one scope with an `org:`/`user:`
      // prefix (stored names never contain `:` — normalizeAgentName strips
      // it), so a same-named record in the OTHER scope can never shadow the
      // agent the binding was created for.
      const ref = parseAgentRef(name);
      const row = await findRow(principal, ref.name, ref.scope);
      if (!row) return undefined;
      const rec = recordOf(row);
      const decorate = opts.decorateResolve ?? ((cfg: AgentConfig<P>) => cfg);
      const sel = rec.tools;
      const approvalEntries = Object.entries(sel?.approval ?? {});
      // Authored tools attached to this agent, resolved per caller into a tool
      // source. Marked alwaysActive so an `enabledTools` restriction on
      // connection tools never hides them (they're capabilities, not picks).
      const authored = rec.exec?.authoredTools?.length ? rec.exec.authoredTools : undefined;
      const loadAuthoredTools = opts.loadAuthoredTools;
      const toolSources =
        authored && loadAuthoredTools
          ? [
              {
                async open(p: P) {
                  // Never let attached-tool resolution fail the whole turn.
                  try {
                    // Resolve under the AGENT's scope: an org agent gets org
                    // tools (shared with every member), not the caller's personal.
                    const tools = await loadAuthoredTools(p, authored, rec.scope);
                    return { tools, alwaysActive: Object.keys(tools), close: async () => {} };
                  } catch (e) {
                    console.warn("Authored-tools attach failed; running without them:", e);
                    return { tools: {}, close: async () => {} };
                  }
                },
              },
            ]
          : undefined;
      return decorate(
        {
          // Which stored version this config is a copy of — recorded on the run
          // and emitted as a trace tag, so an answer can be traced back to the
          // configuration that produced it.
          configVersion: row.publishedVersion ?? undefined,
          model: opts.modelFor(rec.modelId),
          instructions: rec.instructions,
          connections: rec.connections,
          toolSources,
          maxSteps: rec.maxSteps,
          // Restrict callable tools (empty/undefined → all).
          enabledTools: sel?.enabled?.length ? sel.enabled : undefined,
          // Per-tool description overrides → applied to the resolved tools.
          toolDescriptions:
            sel?.descriptions && Object.keys(sel.descriptions).length ? sel.descriptions : undefined,
          // Agents this one may delegate to (→ the runtime's spawn_agent tool).
          subagents: rec.subagents?.length ? rec.subagents : undefined,
          // Per-tool approval override (agent wins): on → require, off → waive.
          toolApproval: approvalEntries.length
            ? Object.fromEntries(
                approvalEntries.map(([n, req]) => [n, req ? "user-approval" : "not-applicable"]),
              )
            : undefined,
          // Code-execution capabilities (sandbox + default harness tools).
          sandbox: rec.exec?.sandbox || undefined,
          sandboxProvider: rec.exec?.provider,
          defaultTools: rec.exec?.defaultTools,
          disableTools: rec.exec?.disableTools,
          providerWebTools: rec.exec?.providerWebTools || undefined,
          renderTools: rec.exec?.renderTools || undefined,
          effort: rec.exec?.effort,
          // Persistent cross-session memory (needs a MemoryProvider on the runtime).
          memory: rec.exec?.memory,
          smoothStream: true,
        },
        rec,
        principal,
      );
    },

    async list(principal): Promise<AgentInfo[]> {
      const rows = await queries.byOwners([ownerKey(principal, "user"), ownerKey(principal, "org")]);
      return rows.map((r) => ({
        name: r.name,
        title: r.title ?? undefined,
        description: r.description ?? undefined,
      }));
    },

    async listRecords(principal) {
      const rows = await queries.byOwners([ownerKey(principal, "user"), ownerKey(principal, "org")]);
      return rows.map(recordOf);
    },

    async getRecord(principal, name) {
      // Pin-aware like `resolve`: run records and channel bindings carry the
      // `org:`/`user:` prefix, and hosts look rubrics/memory up by it.
      const ref = parseAgentRef(name);
      return find(principal, ref.name, ref.scope);
    },

    async listMemoryEnabledNames() {
      return queries.memoryEnabledNames();
    },

    async upsert(principal, rec, opts) {
      await publish(ownerKey(principal, rec.scope), rec, {
        author: editorKey(principal),
        ...opts,
      });
    },

    async remove(principal, scope, name) {
      const owner = ownerKey(principal, scope);
      // Live row first: an interrupted delete then leaves orphan version rows
      // (harmless — nothing resolves them) rather than a live agent whose
      // history has silently vanished.
      await queries.remove(owner, name);
      await queries.removeVersions(owner, name);
      await queries.removeActivations(owner, name);
      await queries.removeDrafts(owner, name);
    },

    async listVersions(principal, name, scope) {
      const owner = ownerKey(principal, scope);
      const [rows, live] = await Promise.all([
        queries.versions(owner, name),
        queries.byOwners([owner], name),
      ]);
      const publishedVersion = live[0]?.publishedVersion ?? null;
      return rows.map(
        (r): AgentVersionMeta => ({
          version: r.version,
          author: r.author ?? undefined,
          source: (r.source ?? undefined) as AgentVersionMeta["source"],
          message: r.changeMessage ?? undefined,
          changedFields: (r.changedFields ?? undefined) as string[] | undefined,
          createdAt: r.createdAt,
          published: r.version === publishedVersion,
        }),
      );
    },

    async getVersion(principal, name, scope, version) {
      const row = await queries.versionAt(ownerKey(principal, scope), name, version);
      return row ? recordFromJson(row.record) : undefined;
    },

    async activateVersion(principal, name, scope, version, opts) {
      const owner = ownerKey(principal, scope);
      const row = await queries.versionAt(owner, name, version);
      if (!row) throw new Error(`No version ${version} of agent "${name}".`);
      // Pin the scope to the one asked for: it decides the owner key, and a
      // record stored under a since-changed scope must not write elsewhere.
      const rec = { ...recordFromJson(row.record), name, scope };
      const now = Date.now();
      // Pointer move only — no version is appended. Flipping between two
      // configurations must not grow history by one duplicate row each time.
      await queries.upsert({
        id: newId(),
        owner,
        rec,
        maxSteps: maxStepsToCol(rec.maxSteps),
        now,
        publishedVersion: version,
      });
      await recordActivation(owner, name, version, opts?.actor ?? editorKey(principal), "activate", now);
    },

    async listActivations(principal, name, scope, limit) {
      const rows = await queries.activations(ownerKey(principal, scope), name, limit);
      return rows.map(
        (r): AgentActivation => ({
          version: r.version,
          actor: r.actor ?? undefined,
          source: (r.source ?? undefined) as AgentActivation["source"],
          createdAt: r.createdAt,
        }),
      );
    },

    async getDraft(principal, name, scope) {
      const row = await queries.draft(ownerKey(principal, scope), name, editorKey(principal));
      if (!row) return undefined;
      return {
        record: recordFromJson(row.record),
        baseVersion: row.baseVersion ?? undefined,
        updatedAt: row.updatedAt,
      } satisfies AgentDraft;
    },

    async saveDraft(principal, name, scope, rec, baseVersion) {
      await queries.upsertDraft({
        owner: ownerKey(principal, scope),
        name,
        editor: editorKey(principal),
        // Pin identity to the arguments: a draft keyed (owner, name, editor)
        // whose record claimed another name would publish to the wrong agent.
        rec: { ...rec, name, scope },
        baseVersion: baseVersion ?? null,
        now: Date.now(),
      });
    },

    async discardDraft(principal, name, scope) {
      await queries.removeDraft(ownerKey(principal, scope), name, editorKey(principal));
    },

    async listDrafts(principal) {
      const mine = editorKey(principal);
      const owners = [ownerKey(principal, "user"), ownerKey(principal, "org")];
      const rows = await queries.draftsByOwners(owners);
      return rows.map(
        (r): AgentDraftSummary => ({
          name: r.name,
          scope: r.owner === owners[1] ? "org" : "user",
          mine: r.editor === mine,
          updatedAt: r.updatedAt,
        }),
      );
    },
  };

  /** Append to the publish timeline. Never fails the write it follows. */
  async function recordActivation(
    owner: string,
    name: string,
    version: number,
    actor: string | undefined,
    source: string,
    now: number,
  ): Promise<void> {
    try {
      await queries.insertActivation({
        id: newActivationId(),
        owner,
        name,
        version,
        actor: actor ?? null,
        source,
        now,
      });
    } catch (error) {
      // The timeline is an audit trail, not a correctness invariant: the live
      // row and the version are already written, and losing one entry must not
      // turn a successful publish into a failed one.
      console.warn(`Could not record agent activation for "${name}":`, error);
    }
  }

  /**
   * Write the live row and append a version — the one path by which a record
   * becomes current.
   *
   * Two ordering rules, neither of which needs a transaction (this store also
   * serves better-sqlite3, whose transaction API rejects an async callback, and
   * libsql, which opens one on a NEW connection — see `createSqliteAdapter`):
   *
   * 1. The VERSION row is written before the live row. Interrupted that way,
   *    history holds a version nothing points at — visible, inert, superseded by
   *    the next publish. The reverse order would leave the live row claiming a
   *    `published_version` that does not exist, breaking history and rollback.
   * 2. The version NUMBER is `max + 1` read outside any lock, so two concurrent
   *    publishes can choose the same one. The UNIQUE (owner, name, version)
   *    index rejects the loser, which re-reads the head and retries — the same
   *    "let the index arbitrate" discipline the rest of this package uses.
   */
  async function publish(
    owner: string,
    rec: AgentRecord,
    opts?: AgentPublishOptions,
  ): Promise<void> {
    const target = canonical(rec);
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
      const head = (await queries.versions(owner, rec.name, 1))[0];
      const now = Date.now();
      // Unchanged content appends nothing, so history stays a list of real
      // changes. The live row is still written: it reconciles a row that drifted
      // from its version (a direct DB edit, an interrupted earlier publish).
      if (head && canonical(recordFromJson(head.record)) === target) {
        await queries.upsert({
          id: newId(),
          owner,
          rec,
          maxSteps: maxStepsToCol(rec.maxSteps),
          now,
          publishedVersion: head.version,
        });
        return;
      }
      const version = (head?.version ?? 0) + 1;
      const message = opts?.message?.trim();
      try {
        await queries.insertVersion({
          id: newVersionId(),
          owner,
          name: rec.name,
          version,
          rec,
          author: opts?.author ?? null,
          source: opts?.source ?? "api",
          changedFields:
            changedFieldsBetween(head ? recordFromJson(head.record) : undefined, rec) ?? null,
          changeMessage: message || null,
          now,
        });
      } catch (error) {
        // Someone else took this number: back off, re-read the head, try again.
        if (isUniqueViolation(error) && attempt < PUBLISH_ATTEMPTS) {
          await publishBackoff();
          continue;
        }
        throw error;
      }
      await queries.upsert({
        id: newId(),
        owner,
        rec,
        maxSteps: maxStepsToCol(rec.maxSteps),
        now,
        publishedVersion: version,
      });
      // A publish is also an activation: recording both here and in
      // `activateVersion` is what makes the timeline complete.
      await recordActivation(owner, rec.name, version, opts?.author, "publish", now);
      return;
    }
    throw new Error(
      `Could not publish agent "${rec.name}": ${PUBLISH_ATTEMPTS} version numbers were taken concurrently.`,
    );
  }
}

/** Shared upsert `set` payload (column shapes match across dialects). */
function upsertValues(row: {
  id: string;
  owner: string;
  rec: AgentRecord;
  maxSteps: number | null;
  now: number;
  publishedVersion: number;
}) {
  const { id, owner, rec, maxSteps, now, publishedVersion } = row;
  return {
    insert: {
      id,
      owner,
      name: rec.name,
      title: rec.title ?? null,
      description: rec.description ?? null,
      modelId: rec.modelId,
      instructions: rec.instructions,
      connections: rec.connections,
      tools: rec.tools ?? null,
      exec: rec.exec ?? null,
      subagents: rec.subagents?.length ? rec.subagents : null,
      attachedEvals: rec.attachedEvals?.length ? rec.attachedEvals : null,
      maxSteps,
      scope: rec.scope,
      publishedVersion,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      title: rec.title ?? null,
      description: rec.description ?? null,
      modelId: rec.modelId,
      instructions: rec.instructions,
      connections: rec.connections,
      tools: rec.tools ?? null,
      exec: rec.exec ?? null,
      subagents: rec.subagents?.length ? rec.subagents : null,
      attachedEvals: rec.attachedEvals?.length ? rec.attachedEvals : null,
      maxSteps,
      scope: rec.scope,
      publishedVersion,
      updatedAt: now,
    },
  };
}

/** Shared version-row insert payload (column shapes match across dialects). */
function versionValues(row: {
  id: string;
  owner: string;
  name: string;
  version: number;
  rec: AgentRecord;
  author: string | null;
  source: string;
  changedFields: string[] | null;
  changeMessage: string | null;
  now: number;
}) {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    version: row.version,
    record: row.rec,
    author: row.author,
    source: row.source,
    changedFields: row.changedFields,
    changeMessage: row.changeMessage,
    createdAt: row.now,
  };
}

/** `AgentBuilderStore` on a Drizzle SQLite database (libsql / better-sqlite3 / Turso). */
export function createSqliteAgentBuilderStore<P>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
  opts: AgentStoreOptions<P>,
): AgentBuilderStore<P> {
  const t = sqliteSchema.agents;
  const v = sqliteSchema.agentVersions;
  const a = sqliteSchema.agentActivations;
  const d = sqliteSchema.agentDrafts;
  return createStore<P>(
    {
      async byOwners(owners, name) {
        const where = name ? and(inArray(t.owner, owners), eq(t.name, name)) : inArray(t.owner, owners);
        return (await db.select().from(t).where(where).orderBy(desc(t.createdAt))) as AgentRow[];
      },
      async memoryEnabledNames() {
        // The JSON column is text in both dialects' storage; a LIKE prefilter
        // is what the sweep wants (cheap, tolerant of false positives).
        const rows = (await db
          .selectDistinct({ name: t.name })
          .from(t)
          .where(like(sql`CAST(${t.exec} AS TEXT)`, '%"memory"%'))) as { name: string }[];
        return rows.map((r) => r.name);
      },
      async upsert(row) {
        const { insert, update } = upsertValues(row);
        await db.insert(t).values(insert).onConflictDoUpdate({ target: [t.owner, t.name], set: update });
      },
      async remove(owner, name) {
        await db.delete(t).where(and(eq(t.owner, owner), eq(t.name, name)));
      },
      async versions(owner, name, limit) {
        const q = db
          .select({
            version: v.version,
            record: v.record,
            author: v.author,
            source: v.source,
            changedFields: v.changedFields,
            changeMessage: v.changeMessage,
            createdAt: v.createdAt,
          })
          .from(v)
          .where(and(eq(v.owner, owner), eq(v.name, name)))
          .orderBy(desc(v.version));
        return (limit ? await q.limit(limit) : await q) as AgentVersionRow[];
      },
      async versionAt(owner, name, version) {
        const rows = (await db
          .select({
            version: v.version,
            record: v.record,
            author: v.author,
            source: v.source,
            changedFields: v.changedFields,
            changeMessage: v.changeMessage,
            createdAt: v.createdAt,
          })
          .from(v)
          .where(and(eq(v.owner, owner), eq(v.name, name), eq(v.version, version)))
          .limit(1)) as AgentVersionRow[];
        return rows[0];
      },
      async insertVersion(row) {
        await db.insert(v).values(versionValues(row));
      },
      async removeVersions(owner, name) {
        await db.delete(v).where(and(eq(v.owner, owner), eq(v.name, name)));
      },
      async insertActivation(row) {
        await db.insert(a).values({
          id: row.id,
          owner: row.owner,
          name: row.name,
          version: row.version,
          actor: row.actor,
          source: row.source,
          createdAt: row.now,
        });
      },
      async activations(owner, name, limit) {
        const q = db
          .select({ version: a.version, actor: a.actor, source: a.source, createdAt: a.createdAt })
          .from(a)
          .where(and(eq(a.owner, owner), eq(a.name, name)))
          .orderBy(desc(a.createdAt));
        return (limit ? await q.limit(limit) : await q) as AgentActivationRow[];
      },
      async removeActivations(owner, name) {
        await db.delete(a).where(and(eq(a.owner, owner), eq(a.name, name)));
      },
      async draft(owner, name, editor) {
        const rows = (await db
          .select()
          .from(d)
          .where(and(eq(d.owner, owner), eq(d.name, name), eq(d.editor, editor)))
          .limit(1)) as AgentDraftRow[];
        return rows[0];
      },
      async upsertDraft(row) {
        await db
          .insert(d)
          .values({
            owner: row.owner,
            name: row.name,
            editor: row.editor,
            record: row.rec,
            baseVersion: row.baseVersion,
            updatedAt: row.now,
          })
          .onConflictDoUpdate({
            target: [d.owner, d.name, d.editor],
            set: { record: row.rec, baseVersion: row.baseVersion, updatedAt: row.now },
          });
      },
      async removeDraft(owner, name, editor) {
        await db
          .delete(d)
          .where(and(eq(d.owner, owner), eq(d.name, name), eq(d.editor, editor)));
      },
      async draftsByOwners(owners) {
        return (await db.select().from(d).where(inArray(d.owner, owners))) as AgentDraftRow[];
      },
      async removeDrafts(owner, name) {
        await db.delete(d).where(and(eq(d.owner, owner), eq(d.name, name)));
      },
    },
    opts,
  );
}

/** `AgentBuilderStore` on a Drizzle Postgres database (node-postgres / postgres-js / PGlite). */
export function createPostgresAgentBuilderStore<P>(
  db: PgDatabase<any, any, any>,
  opts: AgentStoreOptions<P>,
): AgentBuilderStore<P> {
  const t = pgSchema.agents;
  const v = pgSchema.agentVersions;
  const a = pgSchema.agentActivations;
  const d = pgSchema.agentDrafts;
  return createStore<P>(
    {
      async byOwners(owners, name) {
        const where = name ? and(inArray(t.owner, owners), eq(t.name, name)) : inArray(t.owner, owners);
        return (await db.select().from(t).where(where).orderBy(desc(t.createdAt))) as AgentRow[];
      },
      async memoryEnabledNames() {
        // The JSON column is text in both dialects' storage; a LIKE prefilter
        // is what the sweep wants (cheap, tolerant of false positives).
        const rows = (await db
          .selectDistinct({ name: t.name })
          .from(t)
          .where(like(sql`CAST(${t.exec} AS TEXT)`, '%"memory"%'))) as { name: string }[];
        return rows.map((r) => r.name);
      },
      async upsert(row) {
        const { insert, update } = upsertValues(row);
        await db.insert(t).values(insert).onConflictDoUpdate({ target: [t.owner, t.name], set: update });
      },
      async remove(owner, name) {
        await db.delete(t).where(and(eq(t.owner, owner), eq(t.name, name)));
      },
      async versions(owner, name, limit) {
        const q = db
          .select({
            version: v.version,
            record: v.record,
            author: v.author,
            source: v.source,
            changedFields: v.changedFields,
            changeMessage: v.changeMessage,
            createdAt: v.createdAt,
          })
          .from(v)
          .where(and(eq(v.owner, owner), eq(v.name, name)))
          .orderBy(desc(v.version));
        return (limit ? await q.limit(limit) : await q) as AgentVersionRow[];
      },
      async versionAt(owner, name, version) {
        const rows = (await db
          .select({
            version: v.version,
            record: v.record,
            author: v.author,
            source: v.source,
            changedFields: v.changedFields,
            changeMessage: v.changeMessage,
            createdAt: v.createdAt,
          })
          .from(v)
          .where(and(eq(v.owner, owner), eq(v.name, name), eq(v.version, version)))
          .limit(1)) as AgentVersionRow[];
        return rows[0];
      },
      async insertVersion(row) {
        await db.insert(v).values(versionValues(row));
      },
      async removeVersions(owner, name) {
        await db.delete(v).where(and(eq(v.owner, owner), eq(v.name, name)));
      },
      async insertActivation(row) {
        await db.insert(a).values({
          id: row.id,
          owner: row.owner,
          name: row.name,
          version: row.version,
          actor: row.actor,
          source: row.source,
          createdAt: row.now,
        });
      },
      async activations(owner, name, limit) {
        const q = db
          .select({ version: a.version, actor: a.actor, source: a.source, createdAt: a.createdAt })
          .from(a)
          .where(and(eq(a.owner, owner), eq(a.name, name)))
          .orderBy(desc(a.createdAt));
        return (limit ? await q.limit(limit) : await q) as AgentActivationRow[];
      },
      async removeActivations(owner, name) {
        await db.delete(a).where(and(eq(a.owner, owner), eq(a.name, name)));
      },
      async draft(owner, name, editor) {
        const rows = (await db
          .select()
          .from(d)
          .where(and(eq(d.owner, owner), eq(d.name, name), eq(d.editor, editor)))
          .limit(1)) as AgentDraftRow[];
        return rows[0];
      },
      async upsertDraft(row) {
        await db
          .insert(d)
          .values({
            owner: row.owner,
            name: row.name,
            editor: row.editor,
            record: row.rec,
            baseVersion: row.baseVersion,
            updatedAt: row.now,
          })
          .onConflictDoUpdate({
            target: [d.owner, d.name, d.editor],
            set: { record: row.rec, baseVersion: row.baseVersion, updatedAt: row.now },
          });
      },
      async removeDraft(owner, name, editor) {
        await db
          .delete(d)
          .where(and(eq(d.owner, owner), eq(d.name, name), eq(d.editor, editor)));
      },
      async draftsByOwners(owners) {
        return (await db.select().from(d).where(inArray(d.owner, owners))) as AgentDraftRow[];
      },
      async removeDrafts(owner, name) {
        await db.delete(d).where(and(eq(d.owner, owner), eq(d.name, name)));
      },
    },
    opts,
  );
}
