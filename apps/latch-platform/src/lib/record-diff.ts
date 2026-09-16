import type { AgentRecord } from "@/lib/agent-store";

/**
 * Diffing two agent records for the version history.
 *
 * Deliberately two different treatments. `instructions` is prose someone wrote
 * and re-reads, so it gets a real line diff. Everything else is configuration —
 * a model id, a tool list — where "it was X, now it's Y" is the whole story and
 * a line diff would be noise.
 *
 * Pure and dependency-free: the same shape feeds the history preview and the
 * stale-publish warning.
 */

export type LineKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: LineKind;
  text: string;
}

export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
}

export interface RecordDiff {
  /** Line diff of the system prompt; empty when it didn't change. */
  instructions: DiffLine[];
  /** Every other field that differs, rendered for display. */
  fields: FieldChange[];
  /** True when the two records are indistinguishable. */
  identical: boolean;
}

/**
 * Longest common subsequence over LINES, then walked back into a diff.
 *
 * O(n·m) in lines, which is the right trade for prompts: a long one is a few
 * hundred lines, and the quadratic table keeps the implementation small enough
 * to read. A word-level diff would be prettier and much easier to get wrong.
 */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: "removed", text: a[i]! });
  for (; j < m; j++) out.push({ kind: "added", text: b[j]! });
  return out;
}

/** Human-readable one-liner for a non-prompt field value. */
function show(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : undefined;
  return JSON.stringify(value);
}

/** Field order that reads top-down like the editor, not alphabetically. */
const FIELD_ORDER = [
  "title",
  "description",
  "modelId",
  "connections",
  "tools",
  "exec",
  "subagents",
  "maxSteps",
  "scope",
] as const;

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  modelId: "Model",
  connections: "Connections",
  tools: "Tools",
  exec: "Execution",
  subagents: "Subagents",
  maxSteps: "Max steps",
  scope: "Scope",
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field;

/**
 * Compare two records. `before` is the older side; a missing `before` (the first
 * version) yields no diff rather than one showing everything as added — there is
 * nothing to have changed from.
 */
export function diffRecords(
  before: Partial<AgentRecord> | undefined,
  after: Partial<AgentRecord> | undefined,
): RecordDiff {
  if (!before || !after) return { instructions: [], fields: [], identical: true };

  const beforeText = before.instructions ?? "";
  const afterText = after.instructions ?? "";
  const instructions = beforeText === afterText ? [] : diffLines(beforeText, afterText);

  const fields: FieldChange[] = [];
  for (const field of FIELD_ORDER) {
    const a = show((before as Record<string, unknown>)[field]);
    const b = show((after as Record<string, unknown>)[field]);
    if (a !== b) fields.push({ field, before: a, after: b });
  }

  return { instructions, fields, identical: instructions.length === 0 && fields.length === 0 };
}
