import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
  AppMessage,
  ChatRecord,
  RunRecord,
  RunStatus,
  Scope,
  StorageAdapter,
} from "@intentface/latch-core";
import * as schema from "./schema.js";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** A `StorageAdapter` backed by libsql (local file / Turso). SQLite first. */
export function createSqliteAdapter(client: Client): StorageAdapter {
  const db = drizzle(client, { schema });

  const rowToChat = (r: typeof schema.chats.$inferSelect): ChatRecord => ({
    id: r.id,
    orgId: r.orgId,
    userId: r.userId ?? undefined,
    agent: r.agent,
    title: r.title ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  const rowToRun = (r: typeof schema.runs.$inferSelect): RunRecord => ({
    id: r.id,
    chatId: r.chatId,
    agent: r.agent,
    status: r.status as RunStatus,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    usageInputTokens: r.usageInputTokens ?? undefined,
    usageOutputTokens: r.usageOutputTokens ?? undefined,
    costTotal: r.costTotal ?? undefined,
    error: r.error,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  });

  async function getChat(scope: Scope, id: string): Promise<ChatRecord | null> {
    const rows = await db
      .select()
      .from(schema.chats)
      .where(
        and(
          eq(schema.chats.id, id),
          eq(schema.chats.orgId, scope.orgId),
          scope.userId ? eq(schema.chats.userId, scope.userId) : undefined,
        ),
      );
    return rows[0] ? rowToChat(rows[0]) : null;
  }

  return {
    async createChat(input) {
      const now = Date.now();
      const row = {
        id: newId("chat"),
        orgId: input.orgId,
        userId: input.userId ?? null,
        agent: input.agent,
        title: input.title ?? null,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(schema.chats).values(row);
      return rowToChat(row);
    },

    getChat,

    async loadMessages(scope, chatId) {
      // Scope check first — a chat outside the tenant returns nothing.
      const chat = await getChat(scope, chatId);
      if (!chat) return [];
      const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chatId))
        .orderBy(asc(schema.messages.seq));
      return rows.map(
        (r): AppMessage => ({
          id: r.id,
          role: r.role as AppMessage["role"],
          parts: r.parts as AppMessage["parts"],
          metadata: (r.metadata ?? undefined) as AppMessage["metadata"],
        }),
      );
    },

    async appendMessages(chatId, msgs) {
      if (msgs.length === 0) return;
      const [agg] = await db
        .select({ maxSeq: sql<number | null>`max(${schema.messages.seq})` })
        .from(schema.messages)
        .where(eq(schema.messages.chatId, chatId));
      const existing = new Set(
        (
          await db
            .select({ id: schema.messages.id })
            .from(schema.messages)
            .where(eq(schema.messages.chatId, chatId))
        ).map((r) => r.id),
      );
      let next = (agg?.maxSeq ?? -1) + 1;
      for (const m of msgs) {
        const seq = existing.has(m.id) ? 0 : next++;
        await db
          .insert(schema.messages)
          .values({
            id: m.id,
            chatId,
            runId: null,
            seq,
            role: m.role,
            parts: m.parts,
            metadata: m.metadata ?? null,
            createdAt: m.metadata?.createdAt ?? Date.now(),
          })
          // existing message → update content only; seq is preserved.
          .onConflictDoUpdate({
            target: schema.messages.id,
            set: { parts: m.parts, metadata: m.metadata ?? null },
          });
      }
    },

    async createRun(input) {
      const now = Date.now();
      const row = {
        id: newId("run"),
        chatId: input.chatId,
        agent: input.agent,
        status: "active" as RunStatus,
        startedAt: now,
      };
      await db.insert(schema.runs).values(row);
      const got = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, row.id));
      return rowToRun(got[0]!);
    },

    async updateRun(id, patch) {
      const set = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id"),
      );
      if (Object.keys(set).length === 0) return;
      await db
        .update(schema.runs)
        .set(set as Partial<typeof schema.runs.$inferInsert>)
        .where(eq(schema.runs.id, id));
    },

    async getRun(id) {
      const rows = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, id));
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async recordUsage(input) {
      await db.insert(schema.usage).values({
        id: newId("use"),
        orgId: input.orgId,
        userId: input.userId ?? null,
        runId: input.runId,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: input.cost,
        createdAt: Date.now(),
      });
    },
  };
}
