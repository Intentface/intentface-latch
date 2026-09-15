/**
 * sqlite.ts — durable conversation state as ONE extension.
 *
 * Persistence, the lease and fencing are one concern, not three: they all
 * answer "what is true about this conversation right now". Splitting them
 * across extensions forces an ordering dependency between them and turns the
 * save plus its bookkeeping into at-least-once delivery. In one transaction
 * per step both problems disappear.
 *
 * It is `critical`, which is the point of that flag. The default rule — a
 * throwing handler is reported and skipped — is right for a weather-context
 * extension and wrong here. A database that is down has not "produced no
 * effect", it has lost the step. Worse, a claim that throws would leave the run
 * with no lease and the client's messages as truth, so two workers could
 * proceed at once.
 *
 * Requires `better-sqlite3`, which is an optional peer of this package.
 *
 *   CREATE TABLE chats (
 *     id           TEXT PRIMARY KEY,
 *     messages     TEXT    NOT NULL DEFAULT '[]',
 *     step_number  INTEGER NOT NULL DEFAULT 0,
 *     epoch        INTEGER NOT NULL DEFAULT 0,   -- fencing token
 *     lease_owner  TEXT,
 *     lease_until  INTEGER,                      -- ms epoch; future = a run is active
 *     updated_at   INTEGER NOT NULL
 *   );
 */
import type { UIMessage } from "ai";
import { defineExtension, type Extension, type Principal } from "./extension.js";
import { reconcile } from "./reconcile.js";
import type { CostOptions, SpendReport } from "./cost.js";

/** The slice of better-sqlite3 this needs. Structural, so the driver stays optional. */
export interface SqliteDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

/** Thrown when a chat exists but belongs to someone else. */
export class NotYoursError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat ${chatId} belongs to another owner.`);
    this.name = "NotYoursError";
    this.chatId = chatId;
  }
}

/** Thrown when another worker holds the lease on this chat. */
export class ChatBusyError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat ${chatId} is already running somewhere else.`);
    this.name = "ChatBusyError";
    this.chatId = chatId;
  }
}

/** Thrown when our epoch was superseded: another run claimed the chat mid-flight. */
export class FencedError extends Error {
  readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat ${chatId} was claimed by a newer run; this one must not write.`);
    this.name = "FencedError";
    this.chatId = chatId;
  }
}

export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id           TEXT PRIMARY KEY,
      messages     TEXT    NOT NULL DEFAULT '[]',
      step_number  INTEGER NOT NULL DEFAULT 0,
      epoch        INTEGER NOT NULL DEFAULT 0,
      lease_owner  TEXT,
      lease_until  INTEGER,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spend (
      key                TEXT    NOT NULL,
      period             TEXT    NOT NULL,
      cost               REAL    NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      steps              INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (key, period)
    );
  `);

  // Added after the first release, so an existing database needs the column.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`; a duplicate-column error here is
  // the success case on a second run.
  for (const col of ["principal TEXT", "owner TEXT"])
    try {
      db.exec(`ALTER TABLE chats ADD COLUMN ${col}`);
    } catch {
      /* already there */
    }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS chats_owner ON chats (owner)`);
  } catch {
    /* fine */
  }
}

/**
 * Derives the isolation key from a principal.
 *
 * This is the seam that lets a REUSABLE extension work with any application's
 * principal. A published extension must never read a principal's fields — it
 * cannot know them, since the shape is declared by the application — so it
 * takes this function instead and treats the principal itself as opaque.
 * Application-local extensions are free to read fields directly; they know the
 * shape because they declared it.
 *
 * Latch draws the same line: `P` is opaque to the framework and isolation is
 * enforced by an `owner` function the customer supplies to the adapter.
 */
export type OwnerKey = (principal: Principal) => string;

/**
 * Who a stored chat belongs to.
 *
 * This is what makes a run with NO REQUEST possible. A scheduled fire, a
 * resume, or a channel event hours later has nothing to resolve identity from,
 * so it has to come back out of storage. Without it a host would keep its own
 * copy and the two could disagree, which on a tenancy key is the worst kind of
 * bug to find late.
 *
 * Returns undefined for a chat that has never run, so a caller can refuse
 * rather than invent one. Revalidate before using it: it was written when the
 * chat last ran and roles or membership may have changed since, which is why
 * a principal must carry durable identifiers only.
 */
export function loadPrincipal(
  db: SqliteDatabase,
  chatId: string,
  owner?: string,
): Principal | undefined {
  const row = (
    owner === undefined
      ? db.prepare(`SELECT principal FROM chats WHERE id = ?`).get(chatId)
      : db.prepare(`SELECT principal FROM chats WHERE id = ? AND owner = ?`).get(chatId, owner)
  ) as { principal: string | null } | undefined;
  if (!row?.principal) return undefined;
  try {
    return JSON.parse(row.principal) as Principal;
  } catch {
    return undefined;
  }
}

/** How a tally is bucketed. `all` is one running total that never resets. */
export type SpendPeriod = "all" | "day" | "month";

export function periodKey(period: SpendPeriod, now = new Date()): string {
  if (period === "all") return "all";
  const iso = now.toISOString();
  return period === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export interface SpendRow {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
}

const EMPTY: SpendRow = {
  cost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  steps: 0,
};

/** Read a running total. For a header, a usage page, or an admin view. */
export function readSpend(
  db: SqliteDatabase,
  key: string,
  period: SpendPeriod = "all",
  now = new Date(),
): SpendRow {
  const row = db
    .prepare(
      `SELECT cost, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, steps
         FROM spend WHERE key = ? AND period = ?`,
    )
    .get(key, periodKey(period, now)) as Record<string, number> | undefined;
  if (!row) return { ...EMPTY };
  return {
    cost: row.cost ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    steps: row.steps ?? 0,
  };
}

/**
 * A durable tally to hand to `costTracking`, so a limit spans turns instead of
 * resetting every request.
 *
 *   costTracking({ pricing, limit: 5, ...sqliteSpend(db, chatId, "month") })
 *
 * `onSpend` fires after every step AND once at the end, each time with the
 * run's cumulative figure — so this writes the DELTA since its last write, and
 * writes it as `cost = cost + ?` rather than read-modify-write, which keeps two
 * runs on different chats from clobbering a shared tally.
 *
 * The read happens once per run, so two runs that start together against the
 * same key can jointly exceed the limit by up to one run's spend. The chat
 * lease prevents that within a chat; across chats sharing an org budget it is
 * a real, if narrow, window.
 */
export function sqliteSpend(
  db: SqliteDatabase,
  key: string,
  period: SpendPeriod = "all",
): Pick<CostOptions, "startingSpend" | "onSpend"> {
  // Every field of the report is cumulative FOR THIS RUN, and `onSpend` fires
  // after each step plus once at the end. So remember what was written and add
  // only the difference, or the last step gets counted twice.
  const written: SpendRow = { ...EMPTY };

  return {
    startingSpend: () => readSpend(db, key, period).cost,
    onSpend: (r: SpendReport) => {
      const delta: SpendRow = {
        cost: r.cost - written.cost,
        inputTokens: r.inputTokens - written.inputTokens,
        outputTokens: r.outputTokens - written.outputTokens,
        cacheReadTokens: r.cacheReadTokens - written.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens - written.cacheWriteTokens,
        steps: r.steps - written.steps,
      };
      if (!Object.values(delta).some((v) => v !== 0)) return;

      written.cost = r.cost;
      written.inputTokens = r.inputTokens;
      written.outputTokens = r.outputTokens;
      written.cacheReadTokens = r.cacheReadTokens;
      written.cacheWriteTokens = r.cacheWriteTokens;
      written.steps = r.steps;

      // `cost = cost + excluded.cost`, not read-modify-write, so two runs
      // against a shared key cannot clobber each other's increment.
      db.prepare(
        `INSERT INTO spend (key, period, cost, input_tokens, output_tokens,
                            cache_read_tokens, cache_write_tokens, steps, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, period) DO UPDATE SET
           cost               = cost + excluded.cost,
           input_tokens       = input_tokens + excluded.input_tokens,
           output_tokens      = output_tokens + excluded.output_tokens,
           cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           steps              = steps + excluded.steps,
           updated_at         = excluded.updated_at`,
      ).run(
        key,
        periodKey(period),
        delta.cost,
        delta.inputTokens,
        delta.outputTokens,
        delta.cacheReadTokens,
        delta.cacheWriteTokens,
        delta.steps,
        Date.now(),
      );
    },
  };
}

/** Read a transcript without running anything. For a GET/load route. */
export function loadMessages(db: SqliteDatabase, chatId: string, owner?: string): UIMessage[] {
  const row = (
    owner === undefined
      ? db.prepare(`SELECT messages FROM chats WHERE id = ?`).get(chatId)
      : db.prepare(`SELECT messages FROM chats WHERE id = ? AND owner = ?`).get(chatId, owner)
  ) as { messages: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.messages) as UIMessage[];
  } catch {
    return [];
  }
}

export function listChats(
  db: SqliteDatabase,
  owner?: string,
): Array<{ id: string; updatedAt: number }> {
  const rows = (
    owner === undefined
      ? db.prepare(`SELECT id, updated_at FROM chats ORDER BY updated_at DESC`).all()
      : db.prepare(`SELECT id, updated_at FROM chats WHERE owner = ? ORDER BY updated_at DESC`).all(owner)
  ) as Array<{ id: string; updated_at: number }>;
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
}

export interface SqliteOptions {
  /**
   * Derives the isolation key from the run's principal. Supply it in any
   * multi-tenant app: without it a chat is addressable by id alone, so a
   * guessed id reaches another tenant's conversation.
   */
  owner?: OwnerKey;
  /** How long a claim is good for without a renewal. */
  leaseTtlMs?: number;
  /** Run the DDL on first use. Default true. */
  autoMigrate?: boolean;
}

export function sqlitePersistence(
  db: SqliteDatabase,
  chatId: string,
  options: SqliteOptions = {},
): Extension {
  const ttl = options.leaseTtlMs ?? 30_000;
  if (options.autoMigrate !== false) migrate(db);

  return defineExtension(
    "sqlite",
    (ext) => {
      const leaseOwner = crypto.randomUUID();
      let epoch = 0;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const stop = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      };

      /** Save under our epoch. False means we were fenced. */
      const save = (messages: UIMessage[], step: number): boolean =>
        db
          .prepare(
            `UPDATE chats SET messages = ?, step_number = ?, updated_at = ?
              WHERE id = ? AND epoch = ?`,
          )
          .run(JSON.stringify(messages), step, Date.now(), chatId, epoch).changes > 0;

      ext.on("before_agent_start", (incoming, run) => {
        const principal = run.principal;
        const key = options.owner?.(principal) ?? null;
        const now = Date.now();

        // Create it owned, so the first writer becomes the owner atomically.
        db.prepare(
          `INSERT INTO chats (id, messages, owner, updated_at) VALUES (?, '[]', ?, ?)
             ON CONFLICT(id) DO NOTHING`,
        ).run(chatId, key, now);

        // Isolation BEFORE the claim: an existing chat owned by someone else
        // must not be claimable, or a guessed id reaches another tenant.
        if (key !== null) {
          const mine = db.prepare(`SELECT owner FROM chats WHERE id = ?`).get(chatId) as
            | { owner: string | null }
            | undefined;
          // A row predating this column has no owner: adopt it rather than
          // locking the application out of its own history.
          if (mine?.owner != null && mine.owner !== key) throw new NotYoursError(chatId);
        }

        // Claim: bump the epoch so any older run's writes stop landing.
        const claimed = db
          .prepare(
            `UPDATE chats SET epoch = epoch + 1, lease_owner = ?, lease_until = ?, updated_at = ?
              WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)
              RETURNING messages, step_number, epoch`,
          )
          .get(leaseOwner, now + ttl, now, chatId, now) as
          | { messages: string; step_number: number; epoch: number }
          | undefined;

        if (!claimed) throw new ChatBusyError(chatId);
        epoch = claimed.epoch;

        // Record who this chat is for, so a later run with no request can
        // rebuild it. Written every run, so it tracks the current owner.
        if (principal && Object.keys(principal).length)
          db.prepare(`UPDATE chats SET principal = ?, owner = ? WHERE id = ?`).run(
            JSON.stringify(principal),
            key,
            chatId,
          );

        heartbeat = setInterval(() => {
          try {
            db.prepare(
              `UPDATE chats SET lease_until = ? WHERE id = ? AND lease_owner = ? AND epoch = ?`,
            ).run(Date.now() + ttl, chatId, leaseOwner, epoch);
          } catch {
            /* the next step_start catches a lost lease */
          }
        }, Math.max(1_000, Math.floor(ttl / 3)));
        heartbeat.unref?.();

        // The store is the truth for history, but not for approval decisions
        // or client tool outputs: those only exist on the client, and they
        // arrive as an update to a message the store already has. `reconcile`
        // is what keeps a dedupe-by-id from throwing them away.
        let stored: UIMessage[] = [];
        try {
          stored = JSON.parse(claimed.messages) as UIMessage[];
        } catch {
          stored = [];
        }
        return { replace: reconcile(stored, incoming) };
      });

      // Fencing: a worker whose epoch moved must not write over a newer run.
      ext.on("step_start", () => {
        const row = db.prepare(`SELECT epoch FROM chats WHERE id = ?`).get(chatId) as
          | { epoch: number }
          | undefined;
        if (!row || row.epoch !== epoch) {
          stop();
          throw new FencedError(chatId);
        }
        return undefined;
      });

      // The checkpoint. One transaction, so the messages and the step number
      // land together or not at all.
      ext.on("step_end", (messages, info) => {
        const ok = db.transaction(() => save(messages, info.stepNumber))();
        if (!ok) {
          stop();
          throw new FencedError(chatId);
        }
        return undefined;
      });

      ext.on("agent_end", ({ messages, stepCount }) => {
        try {
          db.transaction(() => {
            if (!save(messages, stepCount)) return;
            db.prepare(
              `UPDATE chats SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`,
            ).run(chatId, leaseOwner);
          })();
        } finally {
          stop();
        }
      });

      // A failed run still releases, so the next request is not locked out for
      // a whole lease period.
      ext.on("error", () => {
        try {
          db.prepare(
            `UPDATE chats SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`,
          ).run(chatId, leaseOwner);
        } finally {
          stop();
        }
      });
    },
    { critical: true },
  ) as Extension;
}
