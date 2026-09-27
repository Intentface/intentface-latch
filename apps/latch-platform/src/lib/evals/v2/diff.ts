/**
 * What differs between two configurations, from the fingerprint each answer
 * recorded when it ran (`configFingerprint`) — so a column says what it
 * changed against the baseline, even for a draft edited since. Pure: the
 * page and the Evals agent read it the same way.
 */

export type Config = {
  instructions?: string;
  modelId?: string;
  maxSteps?: number | string | null;
  connections?: string[];
  tools?: unknown;
  exec?: unknown;
};

export type Change = {
  field: "model" | "instructions" | "steps" | "connections" | "tools" | "settings";
  /** One line, as a column header shows it. */
  summary: string;
  /** For instructions: the lines, marked. */
  lines?: { kind: "add" | "del"; text: string }[];
};

/** A fingerprint as a configuration; null when it was not recorded as one (older answers). */
export function configOf(fingerprint: string | undefined): Config | null {
  if (!fingerprint?.startsWith("{")) return null;
  try {
    return JSON.parse(fingerprint) as Config;
  } catch {
    return null;
  }
}

/**
 * Empty is absent: an agent saved with `tools: {enabled: [], approval: {}}`
 * runs exactly like one with no `tools` at all, and `false` like unset.
 */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? v.map(plain) : undefined;
  if (v && typeof v === "object") {
    const kept = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, plain(x)] as const)
      .filter(([, x]) => x !== undefined);
    return kept.length ? Object.fromEntries(kept) : undefined;
  }
  return v === null || v === false || v === "" ? undefined : v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(plain(a) ?? null) === JSON.stringify(plain(b) ?? null);
const short = (model: string) => model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

/** Lines added and removed, in order — a longest-common-subsequence diff, fine for prompts. */
export function lineDiff(a: string, b: string): { kind: "add" | "del"; text: string }[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { kind: "add" | "del"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) (i++, j++);
    // Removed before added, as a diff reads: the old line, then what replaced it.
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ kind: "del", text: x[i++] });
    else out.push({ kind: "add", text: y[j++] });
  }
  return out.filter((l) => l.text.trim());
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const setDiff = (a: string[], b: string[]) => [...b.filter((x) => !a.includes(x)).map((x) => `+${x}`), ...a.filter((x) => !b.includes(x)).map((x) => `−${x}`)];

/** What `to` changes against `from`, most telling first. */
export function configDiff(from: Config, to: Config): Change[] {
  const out: Change[] = [];
  if (!same(from.modelId, to.modelId)) out.push({ field: "model", summary: `model → ${short(String(to.modelId ?? "default"))}` });
  if (!same(from.instructions, to.instructions)) {
    const lines = lineDiff(String(from.instructions ?? ""), String(to.instructions ?? ""));
    const add = lines.filter((l) => l.kind === "add").length;
    const del = lines.length - add;
    out.push({ field: "instructions", summary: `instructions ${[add && `+${add}`, del && `−${del}`].filter(Boolean).join(" ")} line${add + del === 1 ? "" : "s"}`, lines });
  }
  if (!same(from.connections, to.connections)) out.push({ field: "connections", summary: `connections ${setDiff(listOf(from.connections), listOf(to.connections)).join(" ")}` });
  const toolsOf = (t: unknown) => listOf((t as { enabled?: unknown } | null)?.enabled);
  if (!same(from.tools, to.tools)) {
    const d = setDiff(toolsOf(from.tools), toolsOf(to.tools));
    out.push({ field: "tools", summary: d.length ? `tools ${d.join(" ")}` : "tool settings" });
  }
  if (!same(from.maxSteps, to.maxSteps)) out.push({ field: "steps", summary: `steps ${String(from.maxSteps ?? "default")} → ${String(to.maxSteps ?? "default")}` });
  if (!same(from.exec, to.exec)) {
    const a = (plain(from.exec) ?? {}) as Record<string, unknown>;
    const b = (plain(to.exec) ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
    const word = (k: string) => (k === "effort" ? `effort → ${String(b[k] ?? "default")}` : k === "providerWebTools" ? `web tools ${b[k] ? "on" : "off"}` : k.replace(/([A-Z])/g, " $1").toLowerCase());
    out.push({ field: "settings", summary: keys.map(word).join(", ") });
  }
  return out;
}
