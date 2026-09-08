import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { desc, eq, inArray, and, like, sql } from "drizzle-orm";
import type { LanguageModel } from "ai";
import type { AgentConfig, AgentInfo } from "@intentface/latch-core";
import { parseAgentRef } from "@intentface/latch-agent-builder";
import type { AgentBuilderStore, AgentRecord, AgentScope } from "@intentface/latch-agent-builder";
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
  extensions: unknown;
  maxSteps: number | null;
  scope: string;
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
  }): Promise<void>;
  remove(owner: string, name: string): Promise<void>;
}

/** Column value (INTEGER) ↔ AgentRecord.maxSteps: NULL=default, 0=unlimited, N=cap. */
const maxStepsToCol = (m: AgentRecord["maxSteps"]): number | null =>
  m === "unlimited" ? 0 : typeof m === "number" ? m : null;
const maxStepsFromCol = (v: number | null): AgentRecord["maxSteps"] =>
  v == null ? undefined : v === 0 ? "unlimited" : v;

const ownerKeyOf = (segments: string[]): string => segments.map(encodeURIComponent).join("/");

function createStore<P>(queries: AgentQueries, opts: AgentStoreOptions<P>): AgentBuilderStore<P> {
  const ownerKey = (p: P, scope: AgentScope) => ownerKeyOf(opts.owner(p, scope));

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
    extensions: (row.extensions ?? undefined) as AgentRecord["extensions"],
    scope: row.scope as AgentScope,
  });

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
      const rec = await find(principal, ref.name, ref.scope);
      if (!rec) return undefined;
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
          // Pre-turn scripts + templates (needs a ScriptEngine on the runtime).
          extensions: rec.extensions?.length ? rec.extensions : undefined,
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

    async upsert(principal, rec) {
      await queries.upsert({
        id: newId(),
        owner: ownerKey(principal, rec.scope),
        rec,
        maxSteps: maxStepsToCol(rec.maxSteps),
        now: Date.now(),
      });
    },

    async remove(principal, scope, name) {
      await queries.remove(ownerKey(principal, scope), name);
    },
  };
}

/** Shared upsert `set` payload (column shapes match across dialects). */
function upsertValues(row: { id: string; owner: string; rec: AgentRecord; maxSteps: number | null; now: number }) {
  const { id, owner, rec, maxSteps, now } = row;
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
      extensions: rec.extensions?.length ? rec.extensions : null,
      maxSteps,
      scope: rec.scope,
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
      extensions: rec.extensions?.length ? rec.extensions : null,
      maxSteps,
      scope: rec.scope,
      updatedAt: now,
    },
  };
}

/** `AgentBuilderStore` on a Drizzle SQLite database (libsql / better-sqlite3 / Turso). */
export function createSqliteAgentBuilderStore<P>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
  opts: AgentStoreOptions<P>,
): AgentBuilderStore<P> {
  const t = sqliteSchema.agents;
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
    },
    opts,
  );
}
