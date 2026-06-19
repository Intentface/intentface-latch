import { convertToModelMessages, type ModelMessage } from "ai";
import type { AppMessage } from "./message.js";

/**
 * The two message projections (see `message.ts`). `AppMessage` is the stored
 * source of truth; these derive what each *audience* sees, reading the two
 * metadata axes. Both default permissively: absent `visibility` → shown to the
 * user; absent `sendToModel` → fed to the model. Exceptions are explicit.
 */

/** Client projection: keep user-visible messages, drop `internal`/`redacted`. */
export function toClientMessages(messages: AppMessage[]): AppMessage[] {
  return messages.filter((m) => (m.metadata?.visibility ?? "user") === "user");
}

/**
 * Model projection: drop `sendToModel === false`, then convert to model
 * messages. (`data-*` parts — e.g. a compaction marker — are dropped by the
 * SDK during conversion, so they never reach the model regardless.)
 */
export async function toModelMessages(
  messages: AppMessage[],
  opts?: { tools?: Record<string, unknown> },
): Promise<ModelMessage[]> {
  const forModel = messages.filter((m) => m.metadata?.sendToModel !== false);
  return convertToModelMessages(forModel as never, (opts ?? {}) as never);
}
