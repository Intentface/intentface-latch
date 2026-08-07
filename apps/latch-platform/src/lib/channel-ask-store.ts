import type { Client } from "@libsql/client";
import type { AskSession } from "@intentface/latch-channels";

/**
 * `latch_channel_ask` — the in-flight `askUser` questionnaire for a chat, shared
 * by every channel (chat ids are channel-prefixed, e.g. `telegram_<bot>_<user>`,
 * so one table can't collide across surfaces).
 *
 * Chat surfaces ask one question at a time, but `runtime.applyToolResult` closes
 * the whole tool call in one shot — so the answers collected so far have to
 * survive between webhook deliveries, which are separate serverless invocations.
 *
 * `rev` is an optimistic-concurrency fence. Telegram redelivers an update until
 * it gets a 2xx and people double-tap buttons; without the fence a repeated tap
 * would advance the cursor twice and silently skip a question.
 */

/**
 * A questionnaire must survive overnight (people answer in the morning), but a
 * week-old row would silently swallow an unrelated message as an answer.
 */
const ASK_TTL_MS = 24 * 60 * 60 * 1000;

export async function migrateChannelAsk(client: Client): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS latch_channel_ask (
    chat_id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    questions TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    answers TEXT NOT NULL DEFAULT '{}',
    selected TEXT NOT NULL DEFAULT '[]',
    prompt_chat_id TEXT NOT NULL DEFAULT '',
    prompt_ref TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToAsk(r: Record<string, unknown>): AskSession {
  return {
    toolCallId: String(r.tool_call_id),
    nonce: String(r.nonce),
    questions: parseJson<AskSession["questions"]>(r.questions, []),
    cursor: Number(r.cursor ?? 0),
    answers: parseJson<Record<string, string>>(r.answers, {}),
    selected: parseJson<number[]>(r.selected, []),
    promptChatId: String(r.prompt_chat_id ?? ""),
    ...(r.prompt_ref ? { promptRef: String(r.prompt_ref) } : {}),
    rev: Number(r.rev ?? 0),
  };
}

/** The `AskStateStore` methods, mixed into each channel's store. */
export function createChannelAskStore(client: Client) {
  return {
    async getAsk(chatId: string): Promise<AskSession | null> {
      await client.execute({
        sql: `DELETE FROM latch_channel_ask WHERE updated_at < ?`,
        args: [Date.now() - ASK_TTL_MS],
      });
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_ask WHERE chat_id = ?`,
        args: [chatId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      return r ? rowToAsk(r) : null;
    },

    /**
     * Claim the right to prompt. The guarded upsert replaces a session for a
     * DIFFERENT tool call but leaves a LIVE one for the SAME call untouched,
     * reporting `already` — so re-rendering a still-pending questionnaire never
     * posts a twin card whose buttons would both drive one session.
     *
     * An EXPIRED row counts as absent: callers reach `begin` without going
     * through `get` (which is what prunes), so treating a stale row as live
     * would answer `already` and suppress the prompt entirely — the user would
     * see no question and have no button, with the turn still paused.
     */
    async beginAsk(
      chatId: string,
      session: Omit<AskSession, "rev">,
    ): Promise<"started" | "already"> {
      const now = Date.now();
      await client.execute({
        sql: `INSERT INTO latch_channel_ask
                (chat_id, tool_call_id, nonce, questions, cursor, answers, selected,
                 prompt_chat_id, prompt_ref, rev, updated_at)
              VALUES (?, ?, ?, ?, 0, '{}', '[]', ?, NULL, 0, ?)
              ON CONFLICT(chat_id) DO UPDATE SET
                tool_call_id = excluded.tool_call_id,
                nonce = excluded.nonce,
                questions = excluded.questions,
                cursor = 0, answers = '{}', selected = '[]',
                prompt_chat_id = excluded.prompt_chat_id,
                prompt_ref = NULL, rev = 0,
                updated_at = excluded.updated_at
              WHERE latch_channel_ask.tool_call_id <> excluded.tool_call_id
                 OR latch_channel_ask.updated_at < ?`,
        args: [
          chatId,
          session.toolCallId,
          session.nonce,
          JSON.stringify(session.questions),
          session.promptChatId,
          now,
          now - ASK_TTL_MS,
        ],
      });
      // Ours iff the stored nonce is the one we just tried to write.
      const res = await client.execute({
        sql: `SELECT nonce FROM latch_channel_ask WHERE chat_id = ?`,
        args: [chatId],
      });
      return res.rows[0]?.nonce === session.nonce ? "started" : "already";
    },

    async updateAsk(
      chatId: string,
      toolCallId: string,
      rev: number,
      patch: Partial<Pick<AskSession, "cursor" | "answers" | "selected" | "promptRef">>,
    ): Promise<number | null> {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      if (patch.cursor !== undefined) {
        sets.push(`cursor = ?`);
        args.push(patch.cursor);
      }
      if (patch.answers !== undefined) {
        sets.push(`answers = ?`);
        args.push(JSON.stringify(patch.answers));
      }
      if (patch.selected !== undefined) {
        sets.push(`selected = ?`);
        args.push(JSON.stringify(patch.selected));
      }
      if (patch.promptRef !== undefined) {
        sets.push(`prompt_ref = ?`);
        args.push(patch.promptRef);
      }
      if (!sets.length) return rev;
      const next = rev + 1;
      const res = await client.execute({
        sql: `UPDATE latch_channel_ask SET ${sets.join(", ")}, rev = ?, updated_at = ?
              WHERE chat_id = ? AND tool_call_id = ? AND rev = ?`,
        args: [...args, next, Date.now(), chatId, toolCallId, rev],
      });
      return res.rowsAffected === 1 ? next : null;
    },

    /** Fenced delete — true only for the caller that removed it. Gates the submit. */
    async finishAsk(chatId: string, toolCallId: string, rev: number): Promise<boolean> {
      const res = await client.execute({
        sql: `DELETE FROM latch_channel_ask WHERE chat_id = ? AND tool_call_id = ? AND rev = ?`,
        args: [chatId, toolCallId, rev],
      });
      return res.rowsAffected === 1;
    },

    async clearAsk(chatId: string): Promise<AskSession | null> {
      const res = await client.execute({
        sql: `SELECT * FROM latch_channel_ask WHERE chat_id = ?`,
        args: [chatId],
      });
      const r = res.rows[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      await client.execute({
        sql: `DELETE FROM latch_channel_ask WHERE chat_id = ?`,
        args: [chatId],
      });
      return rowToAsk(r);
    },
  };
}
