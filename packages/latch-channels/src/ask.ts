import type { AskSession, Question } from "./types.js";

/**
 * The questionnaire state machine — pure, platform-free, and the single place
 * the answer semantics live, so Telegram and WhatsApp can't drift from each
 * other or from the web composer.
 *
 * A chat surface asks one question at a time, but `applyToolResult` closes the
 * whole `askUser` call in one shot: answers accumulate in an `AskSession` and
 * only the last question emits `completed`.
 *
 * The output is a flat `Record<questionText, answer>` — the same shape a web
 * chat composer submits for `askUser`, including joining multi-select picks
 * with `", "`.
 */

export type AskEvent =
  /** An option button: commits a single-select question, toggles a multi-select one. */
  | { kind: "pick"; option: number }
  /** The "Done" button on a multi-select question. */
  | { kind: "done" }
  /** A typed message, taken as the answer to the question on screen. */
  | { kind: "typed"; text: string };

export type AskStep =
  /** A multi-select tick changed; same question stays on screen. */
  | { kind: "toggled"; selected: number[] }
  /** Question committed, more remain. */
  | {
      kind: "advanced";
      cursor: number;
      answers: Record<string, string>;
      answered: { question: string; answer: string };
    }
  /** Last question committed — submit `output` via `applyToolResult`. */
  | {
      kind: "completed";
      output: Record<string, string>;
      answered: { question: string; answer: string };
    }
  /** Nothing to do (e.g. Done with nothing ticked); `reason` is user-facing. */
  | { kind: "rejected"; reason: string };

const MULTI_JOIN = ", ";

/** Labels of the ticked options, always in OPTION order (not tap order). */
function selectedLabels(q: Question, selected: number[]): string[] {
  return q.options
    .map((o, i) => (selected.includes(i) ? o.label : undefined))
    .filter((l): l is string => l !== undefined);
}

/** Parse "1,3" / "1 3" into option indices; null unless ALL tokens are valid. */
function parseIndexList(q: Question, text: string): number[] | null {
  const tokens = text.split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) return null;
  const out: number[] = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return null;
    const i = Number(t) - 1; // 1-based for humans
    if (i < 0 || i >= q.options.length) return null;
    if (!out.includes(i)) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Interpret typed text as an answer to `q`. Tries, in order: an option label
 * (case-insensitive), a 1-based option number (or list of them, which is how
 * WhatsApp's numbered fallback answers), then the raw text — free-form answers
 * are legitimate, the web composer allows them too.
 */
export function resolveTypedAnswer(q: Question, text: string): string {
  const trimmed = text.trim();
  const byLabel = q.options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
  if (byLabel) return byLabel.label;
  const indices = parseIndexList(q, trimmed);
  if (indices) {
    const labels = indices.map((i) => q.options[i]!.label);
    // A single index answers either kind; a list only makes sense for multi-select.
    if (labels.length === 1 || q.multiSelect) return labels.join(MULTI_JOIN);
  }
  return trimmed;
}

/** Commit `answer` for the current question and move on (or finish). */
function commit(session: AskSession, q: Question, answer: string): AskStep {
  const answers = { ...session.answers, [q.question]: answer };
  const answered = { question: q.question, answer };
  const next = session.cursor + 1;
  if (next >= session.questions.length) return { kind: "completed", output: answers, answered };
  return { kind: "advanced", cursor: next, answers, answered };
}

/** Apply one interaction to a session. Never mutates; returns what to do next. */
export function nextAskStep(session: AskSession, event: AskEvent): AskStep {
  const q = session.questions[session.cursor];
  if (!q) return { kind: "rejected", reason: "This questionnaire is already complete." };

  switch (event.kind) {
    case "pick": {
      const option = q.options[event.option];
      if (!option) return { kind: "rejected", reason: "That option is no longer available." };
      if (!q.multiSelect) return commit(session, q, option.label);
      const selected = session.selected.includes(event.option)
        ? session.selected.filter((i) => i !== event.option)
        : [...session.selected, event.option];
      return { kind: "toggled", selected };
    }
    case "done": {
      if (!q.multiSelect) return { kind: "rejected", reason: "Pick one of the options." };
      const labels = selectedLabels(q, session.selected);
      if (!labels.length) return { kind: "rejected", reason: "Pick at least one option first." };
      return commit(session, q, labels.join(MULTI_JOIN));
    }
    case "typed": {
      const typed = event.text.trim();
      if (!typed) return { kind: "rejected", reason: "That doesn't look like an answer." };
      if (!q.multiSelect) return commit(session, q, resolveTypedAnswer(q, typed));
      // Multi-select: a pure index list replaces the ticks; anything else is
      // appended to them, matching the web composer's options-plus-free-text join.
      const indices = parseIndexList(q, typed);
      if (indices) return commit(session, q, selectedLabels(q, indices).join(MULTI_JOIN));
      return commit(session, q, [...selectedLabels(q, session.selected), typed].join(MULTI_JOIN));
    }
  }
}
