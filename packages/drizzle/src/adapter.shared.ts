import {
  and,
  asc,
  eq,
  getTableColumns,
  getTableName,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  ChatBusyError,
  ChatConflictError,
  type AppMessage,
  type ChatRecord,
  type RunRecord,
  type RunStatus,
  type ScheduleRecord,
  type StorageAdapter,
} from "@intentface/latch-core";

/**
 * Dialect-shared `StorageAdapter` implementation. The SQLite and Postgres entry
 * points (`adapter.ts`, `adapter.pg.ts`) pass their dialect's schema tables and
 * a `withTx` — the only two things that differ. Every query below uses the
 * common query-builder surface (insert / onConflictDoUpdate / update /
 * returning), which both dialects support. Rows are typed structurally (`any`)
 * for the same reason `memory-job-store.shared.ts` does: the two schemas are
 * shape-identical but distinct types.
 */

/** The tables the adapter touches, in either dialect's schema. */
export interface AdapterSchema {
  chats: any;
  messages: any;
  runs: any;
  usage: any;
  schedules: any;
}

export interface SharedAdapterOptions<P> {
  /**
   * Derive the ownership key for a principal — the isolation boundary. Coarser
   * (fewer segments) = more sharing; finer = more isolation. Must be
   * server-derived from the authenticated principal, never client input.
   */
  owner: (principal: P) => string[];
  /**
   * Run a message batch as one unit. Postgres: `db.transaction`. SQLite:
   * sequential on the same handle (synchronous drivers can't take the async
   * callback).
   */
  withTx: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  /**
   * Run independent statements in ONE transaction, returning each statement's
   * result in order (drizzle `db.batch`). Preferred by `openTurn` where the
   * dialect offers it and `withTx` isn't a real transaction (libsql).
   */
  batch?: (stmts: any[]) => Promise<any[]>;
  /** A synchronous transaction (sync SQLite drivers): the builders' `.run()`/`.get()` inside it are atomic. */
  syncTx?: <T>(fn: (tx: any) => T) => T;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * True if a driver error is a primary-key / unique-constraint violation. Walks
 * the cause chain: drizzle wraps driver errors in a "Failed query: …" error and
 * the constraint code lives on the cause (libsql `SQLITE_CONSTRAINT_UNIQUE`, pg
 * `23505`), two levels down for libsql.
 */
export function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (/^SQLITE_CONSTRAINT/i.test(code) || code === "23505")) return true;
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (/unique constraint|primary key|duplicate key|sqlite_constraint/i.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * How long a NON-durable (T1) active run may stay active before a new turn in
 * its chat supersedes it. T1 has no heartbeat, so without this a crashed T1
 * turn would block its chat forever. Durable runs use their lease instead.
 */
export const STALE_RUN_MS = 10 * 60_000;

/** Join an `owner` path into one composite key, segment-encoded so it's unambiguous. */
function ownerKeyOf<P>(owner: (p: P) => string[], principal: P): string {
  return owner(principal).map(encodeURIComponent).join("/");
}

export function makeStorageAdapter<P>(
  db: any,
  s: AdapterSchema,
  opts: SharedAdapterOptions<P>,
): StorageAdapter<P> {
  const ownerKey = (p: P) => ownerKeyOf(opts.owner, p);

  const rowToChat = (r: any): ChatRecord => ({
    id: r.id,
    owner: r.owner,
    agent: r.agent,
    title: r.title ?? undefined,
    kind: r.kind,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  const rowToRun = (r: any): RunRecord => ({
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

  const rowToSchedule = (r: any): ScheduleRecord => ({
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
    onParked: (r.onParked ?? undefined) as ScheduleRecord["onParked"],
    lastChatId: r.lastChatId,
    enabled: r.enabled === 1,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    createdAt: r.createdAt,
  });

  async function getChat(principal: P, id: string): Promise<ChatRecord | null> {
    const rows = await db
      .select()
      .from(s.chats)
      .where(and(eq(s.chats.id, id), eq(s.chats.owner, ownerKey(principal))));
    return rows[0] ? rowToChat(rows[0]) : null;
  }

  /** The instant a live active run stops counting as live (lease, or T1 stale timeout). */
  const liveUntil = sql`coalesce(${s.runs.leaseExpiresAt}, ${s.runs.startedAt} + ${STALE_RUN_MS})`;

  /**
   * One active run per chat, self-healing: an active run whose lease (or T1
   * stale window) has expired is superseded — marked errored, fencing token
   * bumped so its worker's late writes are refused — before a new run opens.
   * A crashed turn therefore never blocks its chat; the next message moves the
   * conversation on, the same rule as a new message closing a pending approval.
   */
  const supersedeStaleQuery = (chatId: string, now: number, exec: any = db) =>
    exec
      .update(s.runs)
      .set({
        status: "errored" as RunStatus,
        error: "superseded: lease expired",
        endedAt: now,
        leaseOwner: null,
        fencingToken: sql`coalesce(${s.runs.fencingToken}, 0) + 1`,
      })
      .where(and(eq(s.runs.chatId, chatId), eq(s.runs.status, "active"), lt(liveUntil, now)));
  async function supersedeStale(exec: any, chatId: string, now: number): Promise<void> {
    await supersedeStaleQuery(chatId, now, exec);
  }

  /** One message upsert (seq computed in-statement) as a query, for batching. */
  const messageInsert = (chatId: string, m: AppMessage, exec: any = db) =>
    exec
      .insert(s.messages)
      .values({
        id: m.id,
        chatId,
        runId: null,
        seq: sql`(select coalesce(max(${s.messages.seq}), -1) + 1 from ${s.messages} where ${s.messages.chatId} = ${chatId})` as unknown as number,
        role: m.role,
        parts: m.parts,
        metadata: m.metadata ?? null,
        createdAt: m.metadata?.createdAt ?? Date.now(),
      })
      // Existing message (same chat + id) → update content only; seq is
      // preserved. Conflict target is the composite PK — a same-id row in
      // ANOTHER chat is a different row, never overwritten from here.
      .onConflictDoUpdate({
        target: [s.messages.chatId, s.messages.id],
        set: { parts: m.parts, metadata: m.metadata ?? null },
      });

  /**
   * Insert a run row. A LIVE active run in the chat trips the partial unique
   * index → a placeholder `ChatBusyError` (retryAfterMs 0). The caller fills
   * in the lease's remaining time OUTSIDE the transaction, because on Postgres
   * a failed statement aborts the transaction and nothing can be read in it.
   */
  async function insertRun(exec: any, row: Record<string, unknown>): Promise<any> {
    try {
      const got = await exec.insert(s.runs).values(row).returning();
      return got[0]!;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      throw new ChatBusyError(String(row.chatId), 0);
    }
  }

  /** The busy refusal with the live run's remaining time, computed on the main connection. */
  async function busyError(chatId: string, now: number): Promise<ChatBusyError> {
    const live: any[] = await db
      .select({ until: liveUntil })
      .from(s.runs)
      .where(and(eq(s.runs.chatId, chatId), eq(s.runs.status, "active")))
      .limit(1);
    const until = live[0] ? Number(live[0].until) : now;
    return new ChatBusyError(chatId, Math.max(1, until - now));
  }

  /** `insertRun` for the non-transactional entry points: turn the placeholder into the real refusal. */
  async function openRunRow(row: Record<string, unknown>, chatId: string, now: number): Promise<any> {
    await supersedeStale(db, chatId, now);
    try {
      return await insertRun(db, row);
    } catch (error) {
      if (error instanceof ChatBusyError) throw await busyError(chatId, now);
      throw error;
    }
  }

  const runRow = (
    principal: P,
    input: { chatId: string; agent: string; kind?: string; lease?: { owner: string; ttlMs: number } },
    now: number,
  ): Record<string, unknown> => ({
    id: newId("run"),
    chatId: input.chatId,
    agent: input.agent,
    status: "active" as RunStatus,
    identity: principal,
    kind: input.kind,
    startedAt: now,
    ...(input.lease
      ? {
          leaseOwner: input.lease.owner,
          leaseExpiresAt: now + input.lease.ttlMs,
          fencingToken: 1,
          heartbeatAt: now,
          attempt: 1,
        }
      : {}),
  });

  /** Append messages on `exec` (db or tx): seq computed inside each INSERT, upsert by (chat, id), touch the chat. */
  async function appendMessagesWith(exec: any, chatId: string, msgs: AppMessage[]): Promise<void> {
    for (const m of msgs) await messageInsert(chatId, m, exec);
    // Chat activity: keep `updatedAt` fresh so `listChats` orders by it.
    await exec.update(s.chats).set({ updatedAt: Date.now() }).where(eq(s.chats.id, chatId));
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
        await db.insert(s.chats).values(row);
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
      const scope = eq(s.chats.owner, ownerKey(principal));
      // The latest run's status per chat, as one correlated subquery over
      // latch_runs_chat_idx — NOT a per-chat run scan in the caller. Latest
      // only: a continuation opens a new run, so a superseded pause stops
      // reporting `awaiting_input` the moment the conversation moves on.
      // Explicitly aliased raw SQL: drizzle renders `${s.chats.id}`
      // UNQUALIFIED inside a select-field subquery, where it resolves to the
      // runs table's own `id` and the correlation silently never matches.
      // `id desc` breaks started_at ties (ms precision) deterministically —
      // an arbitrary but STABLE pick, so the projection can't flap between
      // reads or disagree across dialects.
      const lastRunStatus = sql<
        string | null
      >`(select r.status from ${sql.raw(getTableName(s.runs))} r where r.chat_id = ${sql.raw(getTableName(s.chats))}.id order by r.started_at desc, r.id desc limit 1)`;
      const rows = await db
        .select({ ...getTableColumns(s.chats), lastRunStatus })
        .from(s.chats)
        .where(
          opts?.kind !== undefined
            ? and(scope, eq(s.chats.kind, opts.kind))
            : scope,
        )
        .orderBy(sql`${s.chats.updatedAt} desc`)
        .limit(opts?.limit ?? 100);
      return rows.map((r: any) => ({
        ...rowToChat(r),
        ...(r.lastRunStatus ? { lastRunStatus: r.lastRunStatus as RunStatus } : {}),
      }));
    },

    async loadMessages(principal, chatId) {
      // Scope check first — a chat the caller doesn't own returns nothing.
      const chat = await getChat(principal, chatId);
      if (!chat) return [];
      const rows = await db
        .select()
        .from(s.messages)
        .where(eq(s.messages.chatId, chatId))
        .orderBy(asc(s.messages.seq));
      return rows.map(
        (r: any): AppMessage => ({
          id: r.id,
          role: r.role as AppMessage["role"],
          parts: r.parts as AppMessage["parts"],
          metadata: (r.metadata ?? undefined) as AppMessage["metadata"],
        }),
      );
    },

    async appendMessages(chatId, msgs) {
      if (msgs.length === 0) return;
      // The next seq is computed INSIDE each INSERT (a single statement), so
      // two concurrent appenders can't both read the same max(seq) and then
      // write colliding rows — the statement is atomic, and the UNIQUE
      // (chat_id, seq) index backstops it. `withTx` is the dialect's batch
      // boundary: a real transaction where the driver is async (Postgres,
      // libsql), sequential statements on synchronous better-sqlite3.
      await opts.withTx((tx) => appendMessagesWith(tx, chatId, msgs));
    },

    /**
     * Run + first message in ONE transaction: a busy chat persists nothing, and
     * a crash can't leave a run without its message. The busy placeholder from
     * `insertRun` rolls the transaction back; the real refusal (with the live
     * lease's remaining time) is built on the main connection afterwards.
     */
    async openTurn(principal, input) {
      const now = Date.now();
      const row = runRow(principal, input, now);
      try {
        if (opts.batch) {
          // The statements are independent (the run id is minted here), so a
          // batch is a transaction without an interactive connection.
          const results = await opts.batch([
            supersedeStaleQuery(input.chatId, now),
            db.insert(s.runs).values(row).returning(),
            ...input.messages.map((m) => messageInsert(input.chatId, m)),
            db.update(s.chats).set({ updatedAt: now }).where(eq(s.chats.id, input.chatId)),
          ]);
          return rowToRun((results[1] as any[])[0]);
        }
        if (opts.syncTx) {
          const got = opts.syncTx((tx) => {
            supersedeStaleQuery(input.chatId, now, tx).run();
            const inserted = tx.insert(s.runs).values(row).returning().get();
            for (const m of input.messages) messageInsert(input.chatId, m, tx).run();
            tx.update(s.chats).set({ updatedAt: now }).where(eq(s.chats.id, input.chatId)).run();
            return inserted;
          });
          return rowToRun(got);
        }
        // Real transaction (Postgres). An adapter that is neither batch- nor
        // sync-capable falls through to `withTx`, whose atomicity is its own.
        const inserted = await opts.withTx(async (tx) => {
          await supersedeStale(tx, input.chatId, now);
          const got = await insertRun(tx, row);
          await appendMessagesWith(tx, input.chatId, input.messages);
          return got;
        });
        return rowToRun(inserted);
      } catch (error) {
        if (error instanceof ChatBusyError || isUniqueViolation(error)) {
          throw await busyError(input.chatId, now);
        }
        throw error;
      }
    },

    async createRun(principal, input) {
      const now = Date.now();
      return rowToRun(await openRunRow(runRow(principal, input, now), input.chatId, now));
    },

    async claimRun(input) {
      const now = Date.now();
      const row = runRow(input.principal, { chatId: input.chatId, agent: input.agent, lease: { owner: input.owner, ttlMs: input.ttlMs } }, now);
      return rowToRun(await openRunRow(row, input.chatId, now));
    },

    async heartbeatRun(id, owner, ttlMs, fencingToken) {
      const now = Date.now();
      const updated = await db
        .update(s.runs)
        .set({ leaseExpiresAt: now + ttlMs, heartbeatAt: now })
        .where(
          and(
            eq(s.runs.id, id),
            eq(s.runs.leaseOwner, owner),
            // Fenced: a stale holder whose run was reaped + re-claimed (owner
            // may match again, token was bumped) can't resurrect the lease.
            eq(s.runs.fencingToken, fencingToken),
            eq(s.runs.status, "active"),
          ),
        )
        .returning({ id: s.runs.id });
      return updated.length > 0;
    },

    async reclaimRun(id, owner, ttlMs) {
      const now = Date.now();
      let updated: any[];
      try {
        updated = await db
        .update(s.runs)
        .set({
          status: "active" as RunStatus,
          leaseOwner: owner,
          leaseExpiresAt: now + ttlMs,
          heartbeatAt: now,
          error: null,
          endedAt: null,
          fencingToken: sql`coalesce(${s.runs.fencingToken}, 0) + 1`,
          attempt: sql`coalesce(${s.runs.attempt}, 1) + 1`,
        })
        .where(
          and(
            eq(s.runs.id, id),
            ne(s.runs.status, "completed"),
            // Only runs that WERE leased and whose lease has expired. A
            // never-leased live (T1) run has leaseExpiresAt NULL and must not
            // be seizable; a reaped run keeps its (expired) leaseExpiresAt
            // even though the reaper cleared leaseOwner, so it still matches.
            isNotNull(s.runs.leaseExpiresAt),
            lt(s.runs.leaseExpiresAt, now),
          ),
        )
        .returning();
      } catch (error) {
        // The chat moved on: a fresh message superseded this crashed turn and
        // opened a newer active run (one active per chat). Resuming the old one
        // would interleave — it stays errored, and nobody owns it.
        if (isUniqueViolation(error)) return null;
        throw error;
      }
      return updated[0] ? rowToRun(updated[0]) : null;
    },

    async updateRun(id, patch, guard) {
      const set = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id"),
      );
      if (Object.keys(set).length === 0) return true;
      const where = guard
        ? and(
            eq(s.runs.id, id),
            eq(s.runs.leaseOwner, guard.owner),
            eq(s.runs.fencingToken, guard.fencingToken),
          )
        : eq(s.runs.id, id);
      const updated = await db
        .update(s.runs)
        .set(set)
        .where(where)
        .returning({ id: s.runs.id });
      return updated.length > 0;
    },

    async reapExpiredRuns(now, opts) {
      const reaped = await db
        .update(s.runs)
        .set({
          status: "errored" as RunStatus,
          error: opts?.error ?? "lease expired",
          endedAt: now,
          leaseOwner: null,
          fencingToken: sql`${s.runs.fencingToken} + 1`,
        })
        .where(
          and(
            eq(s.runs.status, "active"),
            lt(s.runs.leaseExpiresAt, now),
          ),
        )
        .returning();
      return reaped.map(rowToRun);
    },

    async getRun(id) {
      const rows = await db
        .select()
        .from(s.runs)
        .where(eq(s.runs.id, id));
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async listRuns(principal, opts) {
      const rows = await db
        .select({ run: s.runs })
        .from(s.runs)
        .innerJoin(s.chats, eq(s.runs.chatId, s.chats.id))
        .where(eq(s.chats.owner, ownerKey(principal)))
        .orderBy(sql`${s.runs.startedAt} desc`)
        .limit(opts?.limit ?? 100);
      return rows.map((r: any) => rowToRun(r.run));
    },

    async recordUsage(principal, input) {
      await db.insert(s.usage).values({
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
        onParked: input.onParked ?? null,
        lastChatId: null,
        enabled: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
      };
      const got = await db.insert(s.schedules).values(row).returning();
      return rowToSchedule(got[0]!);
    },

    async listSchedules(principal) {
      const rows = await db
        .select()
        .from(s.schedules)
        .where(eq(s.schedules.owner, ownerKey(principal)))
        .orderBy(sql`${s.schedules.createdAt} desc`);
      return rows.map(rowToSchedule);
    },

    async deleteSchedule(principal, id) {
      await db
        .delete(s.schedules)
        .where(
          and(eq(s.schedules.id, id), eq(s.schedules.owner, ownerKey(principal))),
        );
    },

    async bumpSchedule(principal, id) {
      const armed = await db
        .update(s.schedules)
        .set({ nextRunAt: 0 })
        // Owner-fenced, and `enabled` only: a spent one-shot stays spent rather
        // than being resurrectable by re-arming its clock.
        .where(
          and(
            eq(s.schedules.id, id),
            eq(s.schedules.owner, ownerKey(principal)),
            eq(s.schedules.enabled, 1),
          ),
        )
        .returning({ id: s.schedules.id });
      return armed.length > 0;
    },

    async claimDueSchedules(now, ttlMs, owner) {
      // Atomic claim: stamp a lease on due, unclaimed/expired rows. NOT
      // exactly-once on its own — the lease is never renewed, so it only
      // serializes claimers within one TTL; the runtime makes the occurrence
      // at-most-once by advancing nextRunAt (completeSchedule) before firing.
      const claimed = await db
        .update(s.schedules)
        .set({ leaseOwner: owner, leaseExpiresAt: now + ttlMs })
        .where(
          and(
            eq(s.schedules.enabled, 1),
            lte(s.schedules.nextRunAt, now),
            or(
              isNull(s.schedules.leaseOwner),
              lt(s.schedules.leaseExpiresAt, now),
            ),
          ),
        )
        .returning();
      return claimed.map(rowToSchedule);
    },

    async completeSchedule(id, patch, owner) {
      await db
        .update(s.schedules)
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
          and(eq(s.schedules.id, id), eq(s.schedules.leaseOwner, owner)),
        );
    },

    async noteScheduleFire(id, patch) {
      // Fenced by the OCCURRENCE (see StorageAdapter): the stamp only lands
      // while last_run_at still holds the value this fire's completeSchedule
      // wrote — a delayed stamp from an older fire no-ops once a newer
      // occurrence has consumed.
      await db
        .update(s.schedules)
        .set({ lastChatId: patch.lastChatId })
        .where(
          and(eq(s.schedules.id, id), eq(s.schedules.lastRunAt, patch.firedAt)),
        );
    },
  };
}
