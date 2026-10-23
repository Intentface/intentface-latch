import {
  and,
  asc,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ChatBusyError,
  ChatConflictError,
  encodeOwnerKey,
  OwnerKeyMismatchError,
  refileTarget,
  type AppMessage,
  type PurgeResult,
  type OwnerScope,
  type ChatRecord,
  type RunFence,
  type RunRecord,
  type RunSettings,
  type RunStatus,
  type ScheduleRecord,
  type StorageAdapter,
} from "@intentface/latch-core";
import { deleteBatch, underOwnerPath } from "./owner-path.js";

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
  /**
   * The database's current time in epoch ms, as SQL. Every lease time — set,
   * renewed, compared — comes from this one clock, so skew between app servers
   * can't make one node reap a run another is still renewing.
   */
  nowMs: SQL;
  /**
   * Postgres: lock the run row (`for share`) while a fenced write checks it, so
   * a concurrent reclaim waits for the write to commit (and a write that waited
   * on a reclaim re-reads the bumped token). SQLite serializes writers already.
   */
  lockFencedRun?: boolean;
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
  return violates(error, /^SQLITE_CONSTRAINT/i, "23505", /unique constraint|primary key|duplicate key|sqlite_constraint/i);
}

/** True if a driver error is a NOT NULL violation (libsql `SQLITE_CONSTRAINT_NOTNULL`, pg `23502`). */
function isNotNullViolation(error: unknown): boolean {
  return violates(error, /^SQLITE_CONSTRAINT_NOTNULL/i, "23502", /not null constraint|null value in column/i);
}

function violates(error: unknown, sqliteCode: RegExp, pgCode: string, text: RegExp): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (sqliteCode.test(code) || code === pgCode)) return true;
    const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (text.test(message)) return true;
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

/** What a re-filed usage row's `run_id` becomes: a link back to nothing. */
const ERASED_RUN = "erased";

/** Join an `owner` path into one composite key; refuses a missing or empty segment. */
function ownerKeyOf<P>(owner: (p: P) => string[], principal: P): string {
  return encodeOwnerKey(owner(principal));
}

export function makeStorageAdapter<P>(
  db: any,
  s: AdapterSchema,
  opts: SharedAdapterOptions<P>,
): StorageAdapter<P> {
  const ownerKey = (p: P) => ownerKeyOf(opts.owner, p);
  const nowMs = opts.nowMs;

  const rowToChat = (r: any): ChatRecord => ({
    id: r.id,
    owner: r.owner,
    agent: r.agent,
    title: r.title ?? undefined,
    kind: r.kind,
    parentAgent: r.parentAgent ?? undefined,
    ...(r.params != null ? { params: r.params } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  const rowToRun = (r: any): RunRecord => ({
    id: r.id,
    chatId: r.chatId,
    agent: r.agent,
    status: r.status as RunStatus,
    ...(r.ownerKey ? { ownerKey: r.ownerKey } : {}),
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
    agentVersion: r.agentVersion,
    settings: r.settings ?? null,
    ...(r.stopRequestedAt != null ? { stopRequestedAt: r.stopRequestedAt } : {}),
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
    ...(r.params != null ? { params: r.params } : {}),
    enabled: r.enabled === 1,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    createdAt: r.createdAt,
  });

  /** A run's owner key: its own, or its chat's for runs stamped before the column existed. */
  const runOwner = sql<string | null>`coalesce(${s.runs.ownerKey}, (select ${s.chats.owner} from ${s.chats} where ${s.chats.id} = ${s.runs.chatId}))`;

  /** The owner key a row was stored under, or `undefined` when there's no such row. */
  async function storedOwner(kind: "chat" | "run" | "schedule", id: string): Promise<string | undefined> {
    const rows: any[] =
      kind === "run"
        ? await db.select({ owner: runOwner }).from(s.runs).where(eq(s.runs.id, id))
        : kind === "chat"
          ? await db.select({ owner: s.chats.owner }).from(s.chats).where(eq(s.chats.id, id))
          : await db.select({ owner: s.schedules.owner }).from(s.schedules).where(eq(s.schedules.id, id));
    return rows[0]?.owner ?? undefined;
  }

  /**
   * Refuse an id-only call whose owner key isn't the row's (OwnerScope). An
   * owner never changes once written, so checking before the write can't race
   * it; a row that doesn't exist is left to the write itself to miss.
   */
  async function checkOwner(kind: "chat" | "run" | "schedule", id: string, scope: OwnerScope<P> | undefined): Promise<void> {
    if (!scope?.ownerKey) return;
    const owner = await storedOwner(kind, id);
    if (owner !== undefined && owner !== scope.ownerKey) throw new OwnerKeyMismatchError(`${kind} ${id}`);
  }

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
      .where(and(eq(s.runs.chatId, chatId), eq(s.runs.status, "active"), lt(liveUntil, nowMs)));
  async function supersedeStale(exec: any, chatId: string, now: number): Promise<void> {
    await supersedeStaleQuery(chatId, now, exec);
  }

  /** Whether `fence`'s run still holds its lease — evaluated inside the write it guards. */
  const fenceHolds = (fence: RunFence) =>
    sql`exists (select 1 from ${s.runs} where ${s.runs.id} = ${fence.runId} and ${s.runs.leaseOwner} = ${fence.owner} and ${s.runs.fencingToken} = ${fence.fencingToken}${opts.lockFencedRun ? sql` for share` : sql``})`;

  /**
   * A chat's id, looked up rather than taken on trust: NULL when the chat is
   * gone, which the NOT NULL `chat_id` columns turn into a failed write. So a
   * run or message for a deleted chat can't land as an orphan. On Postgres it
   * also waits (FOR SHARE) for a deletion of that chat to commit, which is what
   * serializes `deleteChats` with a run starting in the same chat.
   */
  const chatRef = (chatId: string) =>
    sql`(select ${s.chats.id} from ${s.chats} where ${s.chats.id} = ${chatId}${opts.lockFencedRun ? sql` for share` : sql``})`;

  /** The error for a write into a chat that doesn't exist (any more). */
  const chatGone = (chatId: string) => new Error(`Unknown chat: ${chatId}`);

  /**
   * One message upsert (seq computed in-statement) as a query, for batching.
   *
   * With `fence`, the lease check is part of the same statement, so nothing can
   * slip between check and write: a refused insert computes a NULL seq and
   * fails the NOT NULL constraint (rolling back its batch or transaction), and
   * a refused update of an existing message matches no row.
   */
  const messageInsert = (chatId: string, m: AppMessage, exec: any = db, fence?: RunFence) => {
    const nextSeq = sql`(select coalesce(max(${s.messages.seq}), -1) + 1 from ${s.messages} where ${s.messages.chatId} = ${chatId})`;
    return exec
      .insert(s.messages)
      .values({
        id: m.id,
        chatId: chatRef(chatId) as unknown as string,
        runId: null,
        seq: (fence ? sql`case when ${fenceHolds(fence)} then ${nextSeq} end` : nextSeq) as unknown as number,
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
        ...(fence ? { setWhere: fenceHolds(fence) } : {}),
      });
  };

  /**
   * Insert a run row. A LIVE active run in the chat trips the partial unique
   * index → a placeholder `ChatBusyError` (retryAfterMs 0). The caller fills
   * in the lease's remaining time OUTSIDE the transaction, because on Postgres
   * a failed statement aborts the transaction and nothing can be read in it.
   */
  async function insertRun(exec: any, row: Record<string, unknown>, chatId: string): Promise<any> {
    try {
      const got = await exec.insert(s.runs).values(row).returning();
      return got[0]!;
    } catch (error) {
      if (isNotNullViolation(error)) throw chatGone(chatId);
      if (!isUniqueViolation(error)) throw error;
      throw new ChatBusyError(chatId, 0);
    }
  }

  /** The busy refusal with the live run's remaining time, computed on the main connection. */
  async function busyError(chatId: string): Promise<ChatBusyError> {
    const live: any[] = await db
      .select({ left: sql`${liveUntil} - ${nowMs}` })
      .from(s.runs)
      .where(and(eq(s.runs.chatId, chatId), eq(s.runs.status, "active")))
      .limit(1);
    return new ChatBusyError(chatId, Math.max(1, live[0] ? Number(live[0].left) : 1));
  }

  /** `insertRun` for the non-transactional entry points: turn the placeholder into the real refusal. */
  async function openRunRow(row: Record<string, unknown>, chatId: string, now: number): Promise<any> {
    await supersedeStale(db, chatId, now);
    try {
      return await insertRun(db, row, chatId);
    } catch (error) {
      if (error instanceof ChatBusyError) throw await busyError(chatId);
      throw error;
    }
  }

  const runRow = (
    principal: P,
    input: {
      chatId: string;
      agent: string;
      kind?: string;
      agentVersion?: number | null;
      settings?: RunSettings | null;
      lease?: { owner: string; ttlMs: number };
    },
    now: number,
  ): Record<string, unknown> => ({
    id: newId("run"),
    chatId: chatRef(input.chatId),
    agent: input.agent,
    status: "active" as RunStatus,
    // The run inherits its chat's owner: the same key, derived from the same
    // principal the turn's chat was opened for.
    ownerKey: ownerKey(principal),
    identity: principal,
    kind: input.kind,
    // Stamped at OPEN, so a run that errors or crashes still says which agent
    // version it ran — the terminal update it never reaches cannot record it.
    agentVersion: input.agentVersion ?? null,
    // Also stamped at open: recovery needs it most when the run never settled.
    settings: input.settings ?? null,
    startedAt: now,
    ...(input.lease
      ? {
          leaseOwner: input.lease.owner,
          leaseExpiresAt: sql`${nowMs} + ${input.lease.ttlMs}`,
          fencingToken: 1,
          heartbeatAt: nowMs,
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

  /**
   * The fenced append, all-or-nothing in every driver: each statement checks
   * the fence itself, and they run as one batch / transaction so a refusal
   * part-way leaves nothing behind. Resolves whether every message landed.
   */
  async function appendFenced(chatId: string, msgs: AppMessage[], fence: RunFence): Promise<boolean> {
    const touch = (exec: any) =>
      exec.update(s.chats).set({ updatedAt: Date.now() }).where(and(eq(s.chats.id, chatId), fenceHolds(fence)));
    const upserts = (exec: any) => msgs.map((m) => messageInsert(chatId, m, exec, fence).returning({ id: s.messages.id }));
    try {
      let landed: any[][];
      if (opts.batch) {
        landed = (await opts.batch([...upserts(db), touch(db)])).slice(0, msgs.length) as any[][];
      } else if (opts.syncTx) {
        landed = opts.syncTx((tx) => {
          const rows = upserts(tx).map((q: any) => q.all());
          touch(tx).run();
          return rows;
        });
      } else {
        landed = await opts.withTx(async (tx) => {
          const rows: any[][] = [];
          for (const q of upserts(tx)) rows.push(await q);
          await touch(tx);
          return rows;
        });
      }
      // A refused update of an existing message matches no row instead of
      // failing; the fence is read once per transaction, so it refuses all.
      return landed.every((rows) => rows.length > 0);
    } catch (error) {
      if (isNotNullViolation(error)) return false;
      throw error;
    }
  }

  /** One usage row; `owner` may be a lookup (see `recordUsage`). */
  async function insertUsage(
    owner: string,
    input: { runId: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost: number },
  ): Promise<void> {
    await db.insert(s.usage).values({
      id: newId("use"),
      owner,
      runId: input.runId,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      cost: input.cost,
      createdAt: Date.now(),
    });
  }

  /**
   * Remove chats with everything under them but their usage (the purge
   * decides that). Live runs are settled first with their fencing token
   * bumped, so a worker still running one has its writes refused; then
   * messages, runs and the chats themselves. Each step is
   * safe to repeat, so a pass cut short is finished by the next.
   */
  async function removeChats(chatIds: string[]): Promise<Record<string, number>> {
    await db
      .update(s.runs)
      .set({
        status: "errored" as RunStatus,
        error: "deleted",
        endedAt: nowMs,
        leaseOwner: null,
        fencingToken: sql`coalesce(${s.runs.fencingToken}, 0) + 1`,
      })
      .where(and(inArray(s.runs.chatId, chatIds), eq(s.runs.status, "active")));
    const messages = await db.delete(s.messages).where(inArray(s.messages.chatId, chatIds)).returning({ id: s.messages.id });
    const runs = await db.delete(s.runs).where(inArray(s.runs.chatId, chatIds)).returning({ id: s.runs.id });
    const chats = await db.delete(s.chats).where(inArray(s.chats.id, chatIds)).returning({ id: s.chats.id });
    return { chats: chats.length, messages: messages.length, runs: runs.length };
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
        parentAgent: input.parentAgent ?? null,
        params: input.params ?? null,
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

    async appendMessages(chatId, msgs, fence, scope) {
      await checkOwner("chat", chatId, scope);
      if (fence) return msgs.length === 0 || appendFenced(chatId, msgs, fence);
      if (msgs.length === 0) return;
      // The next seq is computed INSIDE each INSERT (a single statement), so
      // two concurrent appenders can't both read the same max(seq) and then
      // write colliding rows — the statement is atomic, and the UNIQUE
      // (chat_id, seq) index backstops it. `withTx` is the dialect's batch
      // boundary: a real transaction where the driver is async (Postgres,
      // libsql), sequential statements on synchronous better-sqlite3.
      try {
        await opts.withTx((tx) => appendMessagesWith(tx, chatId, msgs));
      } catch (error) {
        if (isNotNullViolation(error)) throw chatGone(chatId);
        throw error;
      }
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
          const got = await insertRun(tx, row, input.chatId);
          await appendMessagesWith(tx, input.chatId, input.messages);
          return got;
        });
        return rowToRun(inserted);
      } catch (error) {
        if (error instanceof ChatBusyError || isUniqueViolation(error)) {
          throw await busyError(input.chatId);
        }
        if (isNotNullViolation(error)) throw chatGone(input.chatId);
        throw error;
      }
    },

    async createRun(principal, input) {
      const now = Date.now();
      return rowToRun(await openRunRow(runRow(principal, input, now), input.chatId, now));
    },

    async claimRun(input) {
      const now = Date.now();
      const row = runRow(
        input.principal,
        {
          chatId: input.chatId,
          agent: input.agent,
          agentVersion: input.agentVersion,
          settings: input.settings,
          lease: { owner: input.owner, ttlMs: input.ttlMs },
        },
        now,
      );
      return rowToRun(await openRunRow(row, input.chatId, now));
    },

    async heartbeatRun(id, owner, ttlMs, fencingToken, scope) {
      await checkOwner("run", id, scope);
      const updated = await db
        .update(s.runs)
        .set({ leaseExpiresAt: sql`${nowMs} + ${ttlMs}`, heartbeatAt: nowMs })
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

    async reclaimRun(id, owner, ttlMs, scope) {
      await checkOwner("run", id, scope);
      let updated: any[];
      try {
        updated = await db
        .update(s.runs)
        .set({
          status: "active" as RunStatus,
          leaseOwner: owner,
          leaseExpiresAt: sql`${nowMs} + ${ttlMs}`,
          heartbeatAt: nowMs,
          error: null,
          endedAt: null,
          fencingToken: sql`coalesce(${s.runs.fencingToken}, 0) + 1`,
          attempt: sql`coalesce(${s.runs.attempt}, 1) + 1`,
        })
        .where(
          and(
            eq(s.runs.id, id),
            ne(s.runs.status, "completed"),
            // Someone stopped it: a crash on the way out doesn't bring it back.
            isNull(s.runs.stopRequestedAt),
            // Only runs that WERE leased and whose lease has expired. A
            // never-leased live (T1) run has leaseExpiresAt NULL and must not
            // be seizable; a reaped run keeps its (expired) leaseExpiresAt
            // even though the reaper cleared leaseOwner, so it still matches.
            isNotNull(s.runs.leaseExpiresAt),
            lt(s.runs.leaseExpiresAt, nowMs),
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

    async updateRun(id, patch, guard, scope) {
      await checkOwner("run", id, scope);
      const set = Object.fromEntries(
        // `ownerKey` is stamped at open and never changes.
        Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "id" && k !== "ownerKey"),
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
      // `now` only to simulate time (tests); otherwise the database's clock.
      const at = now ?? nowMs;
      const reaped = await db
        .update(s.runs)
        .set({
          status: "errored" as RunStatus,
          error: opts?.error ?? "lease expired",
          endedAt: at,
          leaseOwner: null,
          fencingToken: sql`${s.runs.fencingToken} + 1`,
        })
        .where(
          and(
            eq(s.runs.status, "active"),
            lt(s.runs.leaseExpiresAt, at),
          ),
        )
        .returning();
      return reaped.map(rowToRun);
    },

    async getRun(id, scope) {
      // The owner comes with the row, so the OwnerScope check needs no query
      // of its own (a running answer reads its run every second).
      const rows = await db
        .select({ run: s.runs, owner: runOwner })
        .from(s.runs)
        .where(eq(s.runs.id, id));
      if (!rows[0]) return null;
      if (scope?.ownerKey && rows[0].owner != null && rows[0].owner !== scope.ownerKey) throw new OwnerKeyMismatchError(`run ${id}`);
      // Asked for a person rather than by key: someone else's run is simply not found.
      if (scope?.principal !== undefined && rows[0].owner !== ownerKey(scope.principal)) return null;
      return rowToRun(rows[0].run);
    },

    async requestStop(principal, chatId) {
      const stamped = await db
        .update(s.runs)
        .set({ stopRequestedAt: nowMs })
        .where(
          and(
            eq(s.runs.chatId, chatId),
            eq(s.runs.status, "active"),
            // Only the caller's chat: the scope is the chat's owner.
            sql`exists (select 1 from ${s.chats} where ${s.chats.id} = ${s.runs.chatId} and ${s.chats.owner} = ${ownerKey(principal)})`,
          ),
        )
        .returning({ id: s.runs.id });
      return stamped[0]?.id ?? null;
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

    async recordUsage(_principal, input) {
      // Usage inherits its run's owner (derive once, inherit), looked up in the
      // same statement: a run that's gone (deleted) gives NULL, which the NOT
      // NULL `owner` turns into a refusal instead of an orphan row. On Postgres
      // the lookup holds a share lock on the run, so a deletion of its chat
      // waits for this insert and then removes it too.
      const owner = sql`(select ${runOwner} from ${s.runs} where ${s.runs.id} = ${input.runId}${opts.lockFencedRun ? sql` for share` : sql``})`;
      try {
        await insertUsage(owner as unknown as string, input);
      } catch (error) {
        if (isNotNullViolation(error)) throw new Error(`Unknown run: ${input.runId}`);
        throw error;
      }
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
        params: input.params ?? null,
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

    async completeSchedule(id, patch, owner, claim, scope) {
      await checkOwner("schedule", id, scope);
      const applied = await db
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
        // The claim's own expiry tells a re-claim by the SAME owner apart
        // (see StorageAdapter.completeSchedule).
        .where(
          and(
            eq(s.schedules.id, id),
            eq(s.schedules.leaseOwner, owner),
            claim ? eq(s.schedules.leaseExpiresAt, claim.leaseExpiresAt) : undefined,
          ),
        )
        .returning({ id: s.schedules.id });
      // Reported, not swallowed: a no-op here means a newer claim holds the
      // occurrence, and the runtime must not fire it too.
      return applied.length > 0;
    },

    async noteScheduleFire(id, patch, scope) {
      await checkOwner("schedule", id, scope);
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

    async deleteChats(principal, ids) {
      if (ids.length === 0) return [];
      const owned: string[] = (
        await db
          .select({ id: s.chats.id })
          .from(s.chats)
          .where(and(inArray(s.chats.id, ids), eq(s.chats.owner, ownerKey(principal))))
      ).map((r: any) => r.id);
      if (owned.length === 0) return [];
      // The decision is made against ONE instant of the database's clock, read
      // once: a lease that expires part-way through can't make one statement
      // keep a chat's rows and the next delete the chat.
      const at = Number((await db.select({ now: nowMs }).from(s.chats).limit(1))[0]?.now ?? Date.now());
      const liveAt = sql`coalesce(${s.runs.leaseExpiresAt}, ${s.runs.startedAt} + ${STALE_RUN_MS}) > ${at}`;
      const live = sql`exists (select 1 from ${s.runs} where ${inArray(s.runs.chatId, owned)} and ${s.runs.status} = 'active' and ${liveAt})`;
      // Usage stays: the ledger records what was spent (see deleteChats).
      const deletes = (exec: any, where: (w: SQL) => SQL | undefined = (w) => w) => [
        exec.delete(s.messages).where(where(inArray(s.messages.chatId, owned))),
        exec.delete(s.runs).where(where(inArray(s.runs.chatId, owned))),
        exec.delete(s.chats).where(where(inArray(s.chats.id, owned))),
      ];
      if (opts.batch) {
        // One transaction without branching: every statement carries the same
        // condition, so all of them apply or none does.
        await opts.batch(deletes(db, (w) => and(w, sql`not ${live}`)));
      } else if (opts.syncTx) {
        opts.syncTx((tx) => {
          if ((tx.select({ one: sql`1` }).from(s.chats).where(live).limit(1).all() as unknown[]).length) return;
          for (const q of deletes(tx)) q.run();
        });
      } else {
        await opts.withTx(async (tx) => {
          // Lock the chats first: a run starting in one of them waits for this
          // to commit (see chatRef), so none can start between check and delete.
          await tx.select({ id: s.chats.id }).from(s.chats).where(inArray(s.chats.id, owned)).for("update");
          // ...and their runs: a usage insert holding a share lock on one (see
          // recordUsage) commits first, against a run that still exists.
          await tx.select({ id: s.runs.id }).from(s.runs).where(inArray(s.runs.chatId, owned)).for("update");
          if ((await tx.select({ one: sql`1` }).from(s.chats).where(live).limit(1)).length) return;
          for (const q of deletes(tx)) await q;
        });
      }
      const kept: any[] = await db.select({ id: s.chats.id }).from(s.chats).where(inArray(s.chats.id, owned)).limit(1);
      if (kept.length) {
        // Refused: an answer is running in one of them. Say which, and for how long.
        const busy: any[] = await db
          .select({ chatId: s.runs.chatId, left: sql`${liveUntil} - ${nowMs}` })
          .from(s.runs)
          .where(and(inArray(s.runs.chatId, owned), eq(s.runs.status, "active")))
          .limit(1);
        throw new ChatBusyError(busy[0]?.chatId ?? kept[0].id, Math.max(1, Number(busy[0]?.left ?? 1)));
      }
      return owned;
    },

    async purgeOwner(segments, opts) {
      const under = (col: any) => underOwnerPath(col, segments);
      const limit = opts?.batchSize ?? 500;
      const removed: Record<string, number> = { chats: 0, messages: 0, runs: 0, usage: 0, usageRefiled: 0, schedules: 0 };
      const refileTo = refileTarget(segments, opts);

      const chats: any[] = await db.select({ id: s.chats.id }).from(s.chats).where(under(s.chats.owner)).limit(limit);
      const chatIds = chats.map((c) => c.id as string);
      if (chatIds.length) Object.assign(removed, await removeChats(chatIds));
      // The usage ledger, as the host chose: re-filed one level up with the
      // run id cleared (a handle back to data that's gone), kept, or deleted.
      let usage = 0;
      if (refileTo) {
        const rows: any[] = await db.select({ id: s.usage.id }).from(s.usage).where(under(s.usage.owner)).limit(limit);
        if (rows.length) {
          await db
            .update(s.usage)
            .set({ owner: encodeOwnerKey(refileTo), runId: ERASED_RUN })
            .where(inArray(s.usage.id, rows.map((r) => r.id)));
        }
        usage = removed.usageRefiled = rows.length;
      } else if (opts?.usage === "delete") {
        usage = removed.usage = await deleteBatch(db, s.usage, s.usage.id, under(s.usage.owner), limit);
      }
      removed.schedules = await deleteBatch(db, s.schedules, s.schedules.id, under(s.schedules.owner), limit);
      const done = chatIds.length < limit && usage < limit && removed.schedules < limit;
      return { removed, done } satisfies PurgeResult;
    },
  };
}
