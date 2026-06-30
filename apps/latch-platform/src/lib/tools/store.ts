import type { Client } from "@libsql/client";

/**
 * Authored tools: reusable JavaScript programs (human- or agent-written) that
 * run in the sandboxed tool runtime (`runTool`) over `input` + an allowlisted
 * `fetch`. Owner-scoped (per org+user), so they're shared across that owner's
 * agents and attachable by name. Idempotent create-if-not-exists.
 */
export interface AuthoredTool {
  owner: string;
  name: string;
  description: string;
  /** JSON Schema for the tool's input (exposed to the model). */
  inputSchema: unknown;
  /** The program body: JS using `input` (the args) + `fetch`. */
  code: string;
  /** Hostnames the program's `fetch` may reach (SSRF-allowlisted). */
  allowedHosts: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolStore {
  list: (owner: string) => Promise<AuthoredTool[]>;
  get: (owner: string, name: string) => Promise<AuthoredTool | null>;
  save: (rec: Omit<AuthoredTool, "createdAt" | "updatedAt">) => Promise<void>;
  delete: (owner: string, name: string) => Promise<void>;
}

export async function migrateAuthoredTools(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_authored_tools (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    code TEXT NOT NULL,
    allowed_hosts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, name)
  )`);
}

/** Parse a JSON column, falling back instead of throwing on a corrupt value. */
const safeParse = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};

const rowToTool = (r: Record<string, unknown>): AuthoredTool => ({
  owner: String(r.owner),
  name: String(r.name),
  description: String(r.description),
  inputSchema: safeParse<unknown>(r.input_schema, { type: "object" }),
  code: String(r.code),
  // Guard the shape too — a corrupt non-array value must not break `.map`/`.some`.
  allowedHosts: (() => {
    const v = safeParse<unknown>(r.allowed_hosts, []);
    return Array.isArray(v) ? v.map(String) : [];
  })(),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export function createToolStore(client: Client): ToolStore {
  return {
    async list(owner) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_authored_tools WHERE owner = ? ORDER BY name ASC`,
        args: [owner],
      });
      return (res.rows as unknown as Record<string, unknown>[]).map(rowToTool);
    },
    async get(owner, name) {
      const res = await client.execute({
        sql: `SELECT * FROM latch_authored_tools WHERE owner = ? AND name = ?`,
        args: [owner, name],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToTool(r) : null;
    },
    async save(rec) {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_authored_tools (owner, name, description, input_schema, code, allowed_hosts, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner, name) DO UPDATE SET
                description = excluded.description,
                input_schema = excluded.input_schema,
                code = excluded.code,
                allowed_hosts = excluded.allowed_hosts,
                updated_at = excluded.updated_at`,
        args: [
          rec.owner,
          rec.name,
          rec.description,
          JSON.stringify(rec.inputSchema ?? { type: "object" }),
          rec.code,
          JSON.stringify(rec.allowedHosts),
          now,
          now,
        ],
      });
    },
    async delete(owner, name) {
      await client.execute({
        sql: `DELETE FROM latch_authored_tools WHERE owner = ? AND name = ?`,
        args: [owner, name],
      });
    },
  };
}
