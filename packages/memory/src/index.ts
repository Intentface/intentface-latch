/**
 * @intentface/latch-memory
 *
 * Pluggable agent memory for Latch: an always-loaded compiled index injected
 * into the system prompt, an episodic store searched on demand, and background
 * extraction/consolidation over a `MemoryStore` seam (Loredex-backed first).
 */
export * from "./types.js";
export * from "./scope.js";
export * from "./index-file.js";
export * from "./extraction-key.js";
export * from "./search-evidence.js";
export * from "./sanitize.js";
export * from "./provider.js";
export * from "./tools.js";
export * from "./store/loredex.js";
export * from "./prompts/inject.js";
export * from "./prompts/extractor.js";
export * from "./prompts/consolidator.js";
export * from "./jobs/types.js";
