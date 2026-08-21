import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { and, asc, eq, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  ChatConflictError,
  type AppMessage,
  type ChatRecord,
  type RunRecord,
  type RunStatus,
  type ScheduleRecord,
  type StorageAdapter,
} from "@intentface/latch-core";
import * as schema from "./schema.js";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** True if a driver error is a primary-key / unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|primary key|duplicate key|sqlite_constraint/i.test(
    message,
  );
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
    kind: r.kind,
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
    kind: r.kind,
    toolsHash: r.toolsHash,
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
    delivery: r.delivery ?? undefined,
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
        kind: input.kind ?? "user",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await db.insert(schema.chats).values(row);
      } catch (error) {
        // A client-supplied id can collide with a chat the caller doesn't own
        // (the scoped getChat missed, so the caller fell through to create).
        // Surface a typed conflict the server layer can map to a 409.
        if (isUniqueViolation(error)) throw new ChatConflictError(row.id);
        throw error;
      }
      return rowToChat(row);
    },

    getChat,

    async listChats(principal, opts) {
      // No kind → all chats (back-compatible); kind → only that kind.
      const scope = eq(schema.chats.owner, ownerKey(principal));
      const rows = await db
        .select()
        .from(schema.chats)
        .where(
          opts?.kind !== undefined
            ? and(scope, eq(schema.chats.kind, opts.kind))
            : scope,
        )
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
      /** Chat activity: keep `updatedAt` fresh so `listChats` orders by it. */
      const touchChat = () =>
        db
          .update(schema.chats)
          .set({ updatedAt: Date.now() })
          .where(eq(schema.chats.id, chatId));
      if (opts.messages) {
        const [c] = await db
          .select()
          .from(schema.chats)
          .where(eq(schema.chats.id, chatId));
        if (c && (await opts.messages.appendMessages(rowToChat(c), msgs))) {
          if (msgs.length > 0) await touchChat();
          return;
        }
      }
      if (msgs.length === 0) return;
      // The next seq is computed INSIDE each INSERT (a single statement), so
      // two concurrent appenders can't both read the same max(seq) and then
      // write colliding rows — the statement is atomic, and the UNIQUE
      // (chat_id, seq) index backstops it. (An explicit db.transaction can't
      // be used here: this adapter also serves synchronous drivers
      // (better-sqlite3), whose native transaction API rejects the async
      // callback that async drivers (libsql) require.)
      const nextSeq = sql`(select coalesce(max(${schema.messages.seq}), -1) + 1 from ${schema.messages} where ${schema.messages.chatId} = ${chatId})`;
      for (const m of msgs) {
        await db
          .insert(schema.messages)
          .values({
            id: m.id,
            chatId,
            runId: null,
            seq: nextSeq as unknown as number,
            role: m.role,
            parts: m.parts,
            metadata: m.metadata ?? null,
            createdAt: m.metadata?.createdAt ?? Date.now(),
          })
          // Existing message (same chat + id) → update content only; seq is
          // preserved. Conflict target is the composite PK — a same-id row in
          // ANOTHER chat is a different row, never overwritten from here.
          .onConflictDoUpdate({
            target: [schema.messages.chatId, schema.messages.id],
            set: { parts: m.parts, metadata: m.metadata ?? null },
          });
      }
      await touchChat();
    },

    async createRun(principal, input) {
      const now = Date.now();
      const row = {
        id: newId("run"),
        chatId: input.chatId,
        agent: input.agent,
        status: "active" as RunStatus,
        identity: principal,
        kind: input.kind,
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

    async heartbeatRun(id, owner, ttlMs, fencingToken) {
      const now = Date.now();
      const updated = await db
        .update(schema.runs)
        .set({ leaseExpiresAt: now + ttlMs, heartbeatAt: now })
        .where(
          and(
            eq(schema.runs.id, id),
            eq(schema.runs.leaseOwner, owner),
            // Fenced: a stale holder whose run was reaped + re-claimed (owner
            // may match again, token was bumped) can't resurrect the lease.
            eq(schema.runs.fencingToken, fencingToken),
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
            // Only runs that WERE leased and whose lease has expired. A
            // never-leased live (T1) run has leaseExpiresAt NULL and must not
            // be seizable; a reaped run keeps its (expired) leaseExpiresAt
            // even though the reaper cleared leaseOwner, so it still matches.
            isNotNull(schema.runs.leaseExpiresAt),
            lt(schema.runs.leaseExpiresAt, now),
          ),
        )
        .returning();
      return updated[0] ? rowToRun(updated[0]) : null;
    },

    async updateRun(id, patch, guard) {
      const set = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id"),
      );
      if (Object.keys(set).length === 0) return true;
      const where = guard
        ? and(
            eq(schema.runs.id, id),
            eq(schema.runs.leaseOwner, guard.owner),
            eq(schema.runs.fencingToken, guard.fencingToken),
          )
        : eq(schema.runs.id, id);
      const updated = await db
        .update(schema.runs)
        .set(set as Partial<typeof schema.runs.$inferInsert>)
        .where(where)
        .returning({ id: schema.runs.id });
      return updated.length > 0;
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
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
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
        delivery: input.delivery ?? null,
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

    async bumpSchedule(principal, id) {
      const armed = await db
        .update(schema.schedules)
        .set({ nextRunAt: 0 })
        // Owner-fenced, and `enabled` only: a spent one-shot stays spent rather
        // than being resurrectable by re-arming its clock.
        .where(
          and(
            eq(schema.schedules.id, id),
            eq(schema.schedules.owner, ownerKey(principal)),
            eq(schema.schedules.enabled, 1),
          ),
        )
        .returning({ id: schema.schedules.id });
      return armed.length > 0;
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

    async completeSchedule(id, patch, owner) {
      await db
        .update(schema.schedules)
        .set({
          nextRunAt: patch.nextRunAt,
          lastRunAt: patch.lastRunAt,
          enabled: patch.enabled ? 1 : 0,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        // Fenced by the claim lease: if our lease expired mid-fire and another
        // node re-claimed the schedule, this no-ops instead of clobbering it.
        .where(
          and(eq(schema.schedules.id, id), eq(schema.schedules.leaseOwner, owner)),
        );
    },
  };
}
