
/**
 * The columns the results table shows, as they travel in the URL: a result
 * is one version's answers in one run, the first being the baseline.
 */

export type Result = { runId: string; version: string };
export type RunInfo = {
  runId: string;
  versions: string[];
  questions: number;
  tries: number;
  name: string | null;
  createdAt: number;
};

/** `runId|version` pairs, comma-separated — how the choice travels in the URL. */
export const encodeResults = (rs: Result[]) => rs.map((r) => `${r.runId}|${r.version}`).join(",");
export const decodeResults = (s: string | undefined): Result[] =>
  (s ?? "")
    .split(",")
    .map((p) => p.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([runId, version]) => ({ runId, version }));

