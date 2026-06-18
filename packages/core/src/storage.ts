import type { AppMessage } from "./message.js";
import type { Scope } from "./principal.js";

/**
 * The single persistence contract.
 *
 * One adapter interface for every backend — no "SQL-only" tier. Drizzle
 * (Postgres/SQLite) is the first implementation; Mongo etc. are first-class
 * behind the same contract. Reads are scoped by `Scope` so tenant isolation is
 * enforced here, below the routes, where it can't be forgotten.
 *
 * v1 surface = the four tables in the plan: chats, messages, runs, usage.
 * `messages` is the source of truth (content + execution metadata on the row).
 */

export type RunStatus = "active" | "awaiting_input" | "completed" | "errored";

export interface ChatRecord {
  id: string;
  orgId: string;
  userId?: string;
  agent: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  chatId: string;
  agent: string;
  status: RunStatus;
  /** Single-writer lease (T2 durability). Null for T1 / non-durable runs. */
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  costTotal?: number;
  error?: string | null;
  startedAt: number;
  endedAt?: number | null;
}

export interface UsageRecord {
  id: string;
  orgId: string;
  userId?: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  createdAt: number;
}

export interface StorageAdapter {
  // chats
  createChat(input: {
    orgId: string;
    userId?: string;
    agent: string;
    title?: string;
  }): Promise<ChatRecord>;
  /** Scoped: returns null if the chat isn't in the caller's tenant. */
  getChat(scope: Scope, id: string): Promise<ChatRecord | null>;

  // messages (the source of truth)
  /** Scoped read of the conversation, oldest first. */
  loadMessages(scope: Scope, chatId: string): Promise<AppMessage[]>;
  /** Upsert messages by id (incremental per-step persistence is allowed). */
  appendMessages(chatId: string, messages: AppMessage[]): Promise<void>;

  // runs (per-turn execution record)
  createRun(input: { chatId: string; agent: string }): Promise<RunRecord>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;

  // usage (billing/quota ledger)
  recordUsage(input: Omit<UsageRecord, "id" | "createdAt">): Promise<void>;
}
