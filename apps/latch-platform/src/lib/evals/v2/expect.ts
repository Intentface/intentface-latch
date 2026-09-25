/**
 * An input's own expectations as numbered items. The grader and the page
 * both number them this way, so a verdict's per-item results line up with
 * what the person wrote. Pure: imported by the runner and by the page.
 */
import type { InputFacts } from "./model";

export type SaysItem = { kind: "mustSay" | "mustNot" | "decline" | "asks"; text: string; question: string };

export function saysItems(facts: InputFacts | undefined): SaysItem[] {
  const out: SaysItem[] = [];
  for (const x of facts?.mustSay ?? []) out.push({ kind: "mustSay", text: x, question: `Does the answer say this: ${x}?` });
  for (const x of facts?.mustNot ?? []) out.push({ kind: "mustNot", text: x, question: `Does the answer avoid saying this: ${x}?` });
  if (facts?.decline) out.push({ kind: "decline", text: "Should decline", question: "Does the answer politely decline to do what was asked, rather than doing it?" });
  for (const x of facts?.asks ?? []) out.push({ kind: "asks", text: x, question: x.trim().endsWith("?") ? x.trim() : `${x.trim()}?` });
  return out;
}

/** A verdict's per-item results, when it carries them: `{"each":[true,false]}`. */
export function eachOf(answer: string): boolean[] | null {
  if (!answer.startsWith("{")) return null;
  try {
    const v = JSON.parse(answer) as { each?: unknown };
    return Array.isArray(v.each) ? v.each.map(Boolean) : null;
  } catch {
    return null;
  }
}
