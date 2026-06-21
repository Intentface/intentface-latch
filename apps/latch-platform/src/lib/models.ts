import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/**
 * The models a UI-created agent may pick. UI passes only a model *id* string, so
 * we map it to a provider model here against this allow-list — never instantiate
 * an arbitrary provider from user input.
 */
export const MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Resolve an allow-listed model id to a provider model (fallback: default). */
export function modelFor(id: string): LanguageModel {
  const allowed = MODELS.some((m) => m.id === id) ? id : DEFAULT_MODEL;
  return anthropic(allowed);
}
