import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type {
  AppMessage,
  ChatRecord,
  RunRecord,
  RunStatus,
  ScheduleRecord,
  StorageAdapter,
} from "@intentface/latch-core";
import * as schema from "./schema.js";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Join an `owner` path into one composite key, segment-encoded so it's unambiguous. */
function ownerKeyOf<P>(owner: (p: P) => string[], principal: P): string {
  return owner(principal).map(encodeURIComponent).join("/");
}

/**
 * Optional override for message persistence — a seam any consumer can supply to
 * route a chat's messages somewhere other than the `latch_messages` table (e.g.
 * bridge a user-facing chat to files it already owns). Both methods receive the
 * resolved `ChatRecord` so the consumer can decide per chat.
 *
 * `loadMessages` returns the messages to use, or `null` to defer to the default
 * table read. `appendMessages` returns `true` if it handled the write, or
 * `false` to defer to the default table write.
 */
export interface MessageStore<P> {
  loadMessages(principal: P, chat: ChatRecord): Promise<AppMessage[] | null>;
  appendMessages(chat: ChatRecord, msgs: AppMessage[]): Promise<boolean>;
}

export interface SqliteAdapterOptions<P> {
  /**
   * Derive the ownership key for a principal — the isolation boundary. Coarser
   * (fewer segments) = more sharing; finer = more isolation. Must be
   * server-derived from the authenticated principal, never client input.
   */
  owner: (principal: P) => string[];
  /**
   * Optional message-persistence override (see `MessageStore`). When present,
   * it's consulted first on load/append; if it declines (null / false) the
   * default `latch_messages` behaviour applies.
   */
  messages?: MessageStore<P>;
}

/**
 * A `StorageAdapter` on a Drizzle SQLite database (libsql / better-sqlite3 /
 * Turso). The caller owns the connection — pass a `drizzle(...)` instance — so
 * the adapter never opens or dialect-binds one itself.
 */
export function createSqliteAdapter<P>(
  db: BaseSQLiteDatabase<"sync" | "async", any, any>,
  opts: SqliteAdapterOptions<P>,
): StorageAdapter<P> {
  const ownerKey = (p: P) => ownerKeyOf(opts.owner, p);

  const rowToChat = (r: typeof schema.chats.$inferSelect): ChatRecord => ({
    id: r.id,
    owner: r.owner,
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
    identity: r.identity ?? undefined,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    fencingToken: r.fencingToken,
    heartbeatAt: r.heartbeatAt,
    attempt: r.attempt,
    usageInputTokens: r.usageInputTokens ?? undefined,
    usageOutputTokens: r.usageOutputTokens ?? undefined,
    usageCacheReadTokens: r.usageCacheReadTokens ?? undefined,
    usageCacheWriteTokens: r.usageCacheWriteTokens ?? undefined,
    costTotal: r.costTotal ?? undefined,
    error: r.error,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  });

  const rowToSchedule = (
    r: typeof schema.schedules.$inferSelect,
  ): ScheduleRecord => ({
    id: r.id,
    owner: r.owner,
    agent: r.agent,
    identity: r.identity ?? undefined,
    cron: r.cron,
    timezone: r.timezone ?? undefined,
    prompt: r.prompt,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    enabled: r.enabled === 1,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    createdAt: r.createdAt,
  });

  async function getChat(principal: P, id: string): Promise<ChatRecord | null> {
    const rows = await db
      .select()
      .from(schema.chats)
      .where(and(eq(schema.chats.id, id), eq(schema.chats.owner, ownerKey(principal))));
    return rows[0] ? rowToChat(rows[0]) : null;
  }

  return {
    async createChat(principal, input) {
      const now = Date.now();
      const row = {
        id: input.id ?? newId("chat"),
        owner: ownerKey(principal),
        agent: input.agent,
        title: input.title ?? null,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(schema.chats).values(row);
      return rowToChat(row);
    },

    getChat,

    async listChats(principal, opts) {
      const rows = await db
        .select()
        .from(schema.chats)
        .where(eq(schema.chats.owner, ownerKey(principal)))
        .orderBy(sql`${schema.chats.updatedAt} desc`)
        .limit(opts?.limit ?? 100);
      return rows.map(rowToChat);
    },

    async loadMessages(principal, chatId) {
      // Scope check first — a chat the caller doesn't own returns nothing.
      const chat = await getChat(principal, chatId);
      if (!chat) return [];
      if (opts.messages) {
        const overridden = await opts.messages.loadMessages(principal, chat);
        if (overridden !== null) return overridden;
      }
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
      if (opts.messages) {
        const [c] = await db
          .select()
          .from(schema.chats)
          .where(eq(schema.chats.id, chatId));
        if (c && (await opts.messages.appendMessages(rowToChat(c), msgs))) {
          return;
        }
      }
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

    async createRun(principal, input) {
      const now = Date.now();
      const row = {
        id: newId("run"),
        chatId: input.chatId,
        agent: input.agent,
        status: "active" as RunStatus,
        identity: principal,
        startedAt: now,
      };
      await db.insert(schema.runs).values(row);
      const got = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, row.id));
      return rowToRun(got[0]!);
    },

    async claimRun(input) {
      const now = Date.now();
      const row = {
        id: newId("run"),
        chatId: input.chatId,
        agent: input.agent,
        status: "active" as RunStatus,
        identity: input.principal,
        leaseOwner: input.owner,
        leaseExpiresAt: now + input.ttlMs,
        fencingToken: 1,
        heartbeatAt: now,
        attempt: 1,
        startedAt: now,
      };
      await db.insert(schema.runs).values(row);
      const got = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, row.id));
      return rowToRun(got[0]!);
    },

    async heartbeatRun(id, owner, ttlMs) {
      const now = Date.now();
      const updated = await db
        .update(schema.runs)
        .set({ leaseExpiresAt: now + ttlMs, heartbeatAt: now })
        .where(
          and(
            eq(schema.runs.id, id),
            eq(schema.runs.leaseOwner, owner),
            eq(schema.runs.status, "active"),
          ),
        )
        .returning({ id: schema.runs.id });
      return updated.length > 0;
    },

    async reclaimRun(id, owner, ttlMs) {
      const now = Date.now();
      const updated = await db
        .update(schema.runs)
        .set({
          status: "active" as RunStatus,
          leaseOwner: owner,
          leaseExpiresAt: now + ttlMs,
          heartbeatAt: now,
          error: null,
          endedAt: null,
          fencingToken: sql`coalesce(${schema.runs.fencingToken}, 0) + 1`,
          attempt: sql`coalesce(${schema.runs.attempt}, 1) + 1`,
        })
        .where(
          and(
            eq(schema.runs.id, id),
            ne(schema.runs.status, "completed"),
            or(
              isNull(schema.runs.leaseOwner),
              lt(schema.runs.leaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      return updated[0] ? rowToRun(updated[0]) : null;
    },

    async updateRun(id, patch, guard) {
      const set = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id"),
      );
      if (Object.keys(set).length === 0) return;
      const where = guard
        ? and(
            eq(schema.runs.id, id),
            eq(schema.runs.leaseOwner, guard.owner),
            eq(schema.runs.fencingToken, guard.fencingToken),
          )
        : eq(schema.runs.id, id);
      await db
        .update(schema.runs)
        .set(set as Partial<typeof schema.runs.$inferInsert>)
        .where(where);
    },

    async reapExpiredRuns(now, opts) {
      const reaped = await db
        .update(schema.runs)
        .set({
          status: "errored" as RunStatus,
          error: opts?.error ?? "lease expired",
          endedAt: now,
          leaseOwner: null,
          fencingToken: sql`${schema.runs.fencingToken} + 1`,
        })
        .where(
          and(
            eq(schema.runs.status, "active"),
            lt(schema.runs.leaseExpiresAt, now),
          ),
        )
        .returning();
      return reaped.map(rowToRun);
    },

    async getRun(id) {
      const rows = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, id));
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async listRuns(principal, opts) {
      const rows = await db
        .select({ run: schema.runs })
        .from(schema.runs)
        .innerJoin(schema.chats, eq(schema.runs.chatId, schema.chats.id))
        .where(eq(schema.chats.owner, ownerKey(principal)))
        .orderBy(sql`${schema.runs.startedAt} desc`)
        .limit(opts?.limit ?? 100);
      return rows.map((r) => rowToRun(r.run));
    },

    async recordUsage(principal, input) {
      await db.insert(schema.usage).values({
        id: newId("use"),
        owner: ownerKey(principal),
        runId: input.runId,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: input.cost,
        createdAt: Date.now(),
      });
    },

    async createSchedule(principal, input) {
      const now = Date.now();
      const row = {
        id: newId("sch"),
        owner: ownerKey(principal),
        agent: input.agent,
        identity: principal,
        cron: input.cron,
        timezone: input.timezone ?? null,
        prompt: input.prompt,
        nextRunAt: input.nextRunAt,
        lastRunAt: null,
        enabled: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
      };
      await db.insert(schema.schedules).values(row);
      const got = await db
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.id, row.id));
      return rowToSchedule(got[0]!);
    },

    async listSchedules(principal) {
      const rows = await db
        .select()
        .from(schema.schedules)
        .where(eq(schema.schedules.owner, ownerKey(principal)))
        .orderBy(sql`${schema.schedules.createdAt} desc`);
      return rows.map(rowToSchedule);
    },

    async deleteSchedule(principal, id) {
      await db
        .delete(schema.schedules)
        .where(
          and(eq(schema.schedules.id, id), eq(schema.schedules.owner, ownerKey(principal))),
        );
    },

    async claimDueSchedules(now, ttlMs, owner) {
      // Atomic exactly-once claim: stamp a lease on due, unclaimed/expired rows.
      const claimed = await db
        .update(schema.schedules)
        .set({ leaseOwner: owner, leaseExpiresAt: now + ttlMs })
        .where(
          and(
            eq(schema.schedules.enabled, 1),
            lte(schema.schedules.nextRunAt, now),
            or(
              isNull(schema.schedules.leaseOwner),
              lt(schema.schedules.leaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      return claimed.map(rowToSchedule);
    },

    async completeSchedule(id, patch) {
      await db
        .update(schema.schedules)
        .set({
          nextRunAt: patch.nextRunAt,
          lastRunAt: patch.lastRunAt,
          enabled: patch.enabled ? 1 : 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(schema.schedules.id, id));
    },
  };
}
