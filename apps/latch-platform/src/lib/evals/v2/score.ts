/**
 * The numbers the Results page shows, in one place, so the Evals agent reads
 * exactly what the person reads: tests per cell, the average input per
 * column, and each column against the baseline, input by input.
 *
 * The unit is the input. A cell counts tests — each item of an input's own
 * lists on its own, beside the checks every input gets — but a column's score
 * averages inputs, and a comparison counts inputs that moved: an input's
 * tests share causes, so they are finer detail, not more evidence.
 */
import { eachOf } from "./expect";

type Grid = {
  inputs: { id: string }[];
  threads: { threadId: string; column: string; inputId: string; attempt: number; error: string | null }[];
  verdicts: { threadId: string; answer: string; failed: boolean; ruling: boolean | null }[];
};

export type Cell = {
  tries: { threadId: string; attempt: number; pass: number; of: number; error: string | null }[];
  /** Mean share of tests passed over the graded tries, or null when none are. */
  rate: number | null;
};

/** Every cell of the grid, keyed "input|column". */
export function cellsOf(grid: Grid): Map<string, Cell> {
  const verdictsOf = new Map<string, Grid["verdicts"]>();
  for (const v of grid.verdicts) verdictsOf.set(v.threadId, [...(verdictsOf.get(v.threadId) ?? []), v]);
  const out = new Map<string, Cell>();
  for (const t of grid.threads) {
    const key = `${t.inputId}|${t.column}`;
    const cell = out.get(key) ?? { tries: [], rate: null };
    // Tests, not checks: a check over an input's list counts each item; a
    // person's ruling, where given, stands for the whole check.
    let pass = 0;
    let of = 0;
    for (const v of verdictsOf.get(t.threadId) ?? []) {
      const each = v.ruling === null ? eachOf(v.answer) : null;
      if (each) {
        pass += each.filter(Boolean).length;
        of += each.length;
      } else {
        pass += (v.ruling ?? v.failed) ? 0 : 1;
        of += 1;
      }
    }
    cell.tries.push({ threadId: t.threadId, attempt: t.attempt, pass, of, error: t.error });
    out.set(key, cell);
  }
  for (const cell of out.values()) {
    cell.tries.sort((a, b) => a.attempt - b.attempt);
    const graded = cell.tries.filter((x) => !x.error && x.of);
    cell.rate = graded.length ? graded.reduce((a, x) => a + x.pass / x.of, 0) / graded.length : null;
  }
  return out;
}

/** A column's score: the average input's share of tests passed — each input weighs the same. */
export function columnRate(grid: Grid, cells: Map<string, Cell>, label: string) {
  const rates = grid.inputs.flatMap((i) => {
    const r = cells.get(`${i.id}|${label}`)?.rate;
    return r === null || r === undefined ? [] : [r];
  });
  return rates.length ? rates.reduce((a, r) => a + r, 0) / rates.length : null;
}

/** How likely a split this lopsided is by chance, if the change did nothing: a two-sided sign test on the inputs that moved. */
export function signTest(up: number, down: number) {
  const n = up + down;
  const k = Math.min(up, down);
  if (!n) return 1;
  let c = 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i) c = (c * (n - i + 1)) / i;
    sum += c;
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}

/** One column against the baseline, input by input, on the inputs both answered. */
export function versus(grid: Grid, cells: Map<string, Cell>, base: string, label: string) {
  let up = 0;
  let down = 0;
  let same = 0;
  for (const i of grid.inputs) {
    const a = cells.get(`${i.id}|${base}`)?.rate ?? null;
    const b = cells.get(`${i.id}|${label}`)?.rate ?? null;
    if (a === null || b === null) continue;
    if (b > a) up++;
    else if (b < a) down++;
    else same++;
  }
  return { up, down, same, p: signTest(up, down) };
}

/**
 * The verdict in words. Clearly: chance would split them this unevenly less
 * than 1 time in 20. Maybe: it leans one way, but chance does that often
 * enough to need more tries.
 */
export function verdictFor({ up, down, same, p }: { up: number; down: number; same?: number; p: number }) {
  // No input graded in both: nothing was compared, which is not "no change".
  if (!up && !down && same === 0) return "Nothing to compare";
  if (!up && !down) return "No change";
  if (p < 0.05) return up > down ? "Clearly better" : "Clearly worse";
  if (p < 0.25 && up !== down) return up > down ? "Maybe better" : "Maybe worse";
  return "No real difference";
}
