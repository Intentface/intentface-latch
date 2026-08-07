import { Cron } from "croner";

/**
 * The croner-backed next-fire evaluator for scheduled agents — pass as the
 * runtime config's `cron`. One implementation so hosts stop copy-pasting the
 * same three lines (and drift on timezone handling).
 *
 * Expressions are interpreted in the schedule's IANA timezone so "9am daily"
 * means the user's 9am; defaults to UTC when none is set. Returns the next
 * fire time (epoch ms) strictly after `afterMs`, or null when the expression
 * never fires again.
 */
export function createCronerEvaluator(): (
  expr: string,
  afterMs: number,
  timezone?: string,
) => number | null {
  return (expr, afterMs, timezone) =>
    new Cron(expr, { timezone: timezone || "UTC" }).nextRun(new Date(afterMs))?.getTime() ?? null;
}
