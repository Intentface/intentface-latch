/**
 * Which first-party provider a model id belongs to. ONE place for the id-prefix
 * heuristic that used to live in three files (catalog fallback, provider tools,
 * prompt caching) — a catalog entry wins when one is available; the prefixes
 * cover models not in the catalog (offline fallback list, custom ids).
 */
export type ProviderId = "anthropic" | "openai" | "google";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google"];

/** Provider by id prefix alone: claude → anthropic; gpt/o-series → openai; gemini/gemma → google. */
export function providerFromId(modelId: string): ProviderId | undefined {
  if (/^claude/i.test(modelId)) return "anthropic";
  if (/^(gpt|o\d|chatgpt)/i.test(modelId)) return "openai";
  if (/^(gemini|gemma)/i.test(modelId)) return "google";
  return undefined;
}

/**
 * Provider for a model id: the catalog's answer when the id is listed, else the
 * id-prefix heuristic. `catalog` is any list of `{ id, provider }`.
 */
export function providerOf(
  modelId: string,
  catalog?: ReadonlyArray<{ id: string; provider: string }>,
): ProviderId | undefined {
  const listed = catalog?.find((m) => m.id === modelId)?.provider;
  if (listed && (PROVIDER_IDS as readonly string[]).includes(listed)) return listed as ProviderId;
  return providerFromId(modelId);
}
