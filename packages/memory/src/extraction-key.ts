import { EXTRACTION_PROMPT_VERSION } from "./prompts/extractor.js";

/**
 * Extraction-run idempotency keys.
 *
 * A key fingerprints WHAT an extraction run processed: the content of the
 * message window plus the extraction prompt version. The sweep persists the
 * key of the last COMPLETED run per chat (`last_extracted_key`) and skips a
 * new paid run whenever the next window hashes to the same key (watermark
 * reset, replayed rows) — including runs that yielded zero memories, where
 * the recorded key doubles as a tombstone so the same content is never
 * re-extracted. FAILED runs (LLM error/timeout) never record a key, so they
 * stay eligible for retry.
 */

/** FNV-1a 64-bit, hex — deterministic, dependency-free (Node/edge safe). */
function fnv1a64(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The idempotency key for one extraction window. Hashes role + text only
 * (order-preserving, unambiguously framed), deliberately NOT `seq`: a
 * re-sequenced chat (legacy heal, replay) still hashes the same, which is
 * exactly the duplicate-run case the key exists to suppress. Bumping
 * `EXTRACTION_PROMPT_VERSION` changes every key, so already-tombstoned
 * windows become extractable again under the new prompt.
 */
export function extractionRunKey(
  messages: ReadonlyArray<{ role: string; text: string }>,
): string {
  const payload = messages.map((m) => `${m.role}\u0000${m.text}`).join("\u0001");
  return `x${EXTRACTION_PROMPT_VERSION}:${fnv1a64(payload)}`;
}
