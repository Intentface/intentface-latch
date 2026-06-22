import type { Client } from "@libsql/client";
import type { LanguageModel } from "ai";
import type { AgentConfig, AgentInfo, DynamicAgentStore } from "@intentface/latch-core";
import type { Principal } from "./session";
import type { CredentialScope } from "./credentials";

/**
 * UI-created agents, stored in a `latch_agents` table (config isn't secret).
 * Owner-keyed for org/personal scope, same as everything else. `resolve` builds
 * the same `AgentConfig` a code agent would (model from the allow-list,
 * instructions, connection names); the `tools` column is reserved for code-mode.
 */
export interface AgentRecord {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  /** Tool-loop ceiling: a number caps steps; "unlimited" runs until done; undefined → default. */
  maxSteps?: number | "unlimited";
  scope: CredentialScope;
}

/** Column value (INTEGER) ↔ AgentConfig.maxSteps: NULL=default, 0=unlimited, N=cap. */
const maxStepsToCol = (m: AgentRecord["maxSteps"]): number | null =>
  m === "unlimited" ? 0 : typeof m === "number" ? m : null;
const maxStepsFromCol = (v: unknown): AgentRecord["maxSteps"] =>
  v == null ? undefined : Number(v) === 0 ? "unlimited" : Number(v);

const ownerKey = (p: Principal, scope: CredentialScope): string =>
  (scope === "org" ? [p.orgId] : [p.orgId, p.userId ?? ""])
    .map(encodeURIComponent)
    .join("/");

const newId = () => `agt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export async function migrateAgents(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_agents (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
    title TEXT, description TEXT, model_id TEXT NOT NULL, instructions TEXT NOT NULL,
    connections TEXT NOT NULL, tools TEXT, scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS latch_agents_owner_name ON latch_agents (owner, name)`,
  );
  // Idempotent add for existing dev DBs (sqlite has no ADD COLUMN IF NOT EXISTS).
  try {
    await client.execute(`ALTER TABLE latch_agents ADD COLUMN max_steps INTEGER`);
  } catch {
    /* column already exists */
  }
}

export interface AgentStore extends DynamicAgentStore<Principal> {
  /** Full records visible to the caller (org + personal), for the editor. */
  listRecords(p: Principal): Promise<(AgentRecord & { scope: CredentialScope })[]>;
  upsert(p: Principal, rec: AgentRecord): Promise<void>;
  remove(p: Principal, scope: CredentialScope, name: string): Promise<void>;
}

export function createAgentStore(
  client: Client,
  modelFor: (id: string) => LanguageModel,
): AgentStore {
  const recordOf = (row: Record<string, unknown>): AgentRecord => ({
    name: String(row.name),
    title: (row.title as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    modelId: String(row.model_id),
    instructions: String(row.instructions),
    connections: JSON.parse(String(row.connections)) as string[],
    maxSteps: maxStepsFromCol(row.max_steps),
    scope: String(row.scope) as CredentialScope,
  });

  async function find(p: Principal, name: string): Promise<AgentRecord | undefined> {
    // Personal wins over org on a name clash.
    const res = await client.execute({
      sql: "SELECT * FROM latch_agents WHERE name = ? AND owner IN (?, ?)",
      args: [name, ownerKey(p, "user"), ownerKey(p, "org")],
    });
    const rows = res.rows as unknown as Record<string, unknown>[];
    const personal = rows.find((r) => r.owner === ownerKey(p, "user"));
    const row = personal ?? rows[0];
    return row ? recordOf(row) : undefined;
  }

  return {
    async resolve(name, principal): Promise<AgentConfig<Principal> | undefined> {
      const rec = await find(principal, name);
      if (!rec) return undefined;
      return {
        model: modelFor(rec.modelId),
        instructions: rec.instructions,
        connections: rec.connections,
        maxSteps: rec.maxSteps,
        smoothStream: true,
      };
    },

    async list(principal): Promise<AgentInfo[]> {
      const res = await client.execute({
        sql: "SELECT name, title, description FROM latch_agents WHERE owner IN (?, ?) ORDER BY created_at DESC",
        args: [ownerKey(principal, "user"), ownerKey(principal, "org")],
      });
      return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
        name: String(r.name),
        title: (r.title as string) ?? undefined,
        description: (r.description as string) ?? undefined,
      }));
    },

    async listRecords(principal) {
      const res = await client.execute({
        sql: "SELECT * FROM latch_agents WHERE owner IN (?, ?) ORDER BY created_at DESC",
        args: [ownerKey(principal, "user"), ownerKey(principal, "org")],
      });
      return (res.rows as unknown as Record<string, unknown>[]).map((r) => ({
        ...recordOf(r),
        scope: String(r.scope) as CredentialScope,
      }));
    },

    async upsert(principal, rec) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_agents
          (id, owner, name, title, description, model_id, instructions, connections, tools, max_steps, scope, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
          ON CONFLICT(owner, name) DO UPDATE SET
            title=excluded.title, description=excluded.description, model_id=excluded.model_id,
            instructions=excluded.instructions, connections=excluded.connections,
            max_steps=excluded.max_steps, scope=excluded.scope, updated_at=excluded.updated_at`,
        args: [
          newId(),
          ownerKey(principal, rec.scope),
          rec.name,
          rec.title ?? null,
          rec.description ?? null,
          rec.modelId,
          rec.instructions,
          JSON.stringify(rec.connections),
          maxStepsToCol(rec.maxSteps),
          rec.scope,
          now,
          now,
        ],
      });
    },

    async remove(principal, scope, name) {
      await client.execute({
        sql: "DELETE FROM latch_agents WHERE owner = ? AND name = ?",
        args: [ownerKey(principal, scope), name],
      });
    },
  };
}
