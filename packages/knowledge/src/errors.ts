/**
 * Why a knowledge operation was refused. Tools return it to the model as an
 * error result, so the agent can adjust (read first, pick another path).
 *
 * - `not_found`: no such file, or one the caller can't see (the two are
 *   deliberately the same answer).
 * - `forbidden`: the caller can see it but not change it.
 * - `read_only`: the mount can't be changed from a conversation.
 * - `conflict`: the file changed since it was read, or the edit's text isn't
 *   there exactly once.
 * - `invalid`: a malformed path, pattern or argument.
 */
export type KnowledgeErrorCode = "not_found" | "forbidden" | "read_only" | "conflict" | "invalid";

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export function isKnowledgeError(e: unknown): e is KnowledgeError {
  return e instanceof KnowledgeError || (e as { name?: unknown } | null)?.name === "KnowledgeError";
}
