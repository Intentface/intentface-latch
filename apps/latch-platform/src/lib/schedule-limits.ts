import { Cron } from "croner";
import type { Runtime } from "@intentface/latch-core";
import type { Principal } from "./session";

/**
 * Limits on AGENT-created schedules.
 *
 * Every model-driven path that can create a schedule shares these — the harness
 * `create_schedule` and the Agent Builder's `create_agent_schedule`. A model
 * asked to "keep me posted" will happily write `* * * * *`, and a loop will
 * happily install it a hundred times; on a channel both read as the bot
 * spamming you.
 *
 * Deliberately NOT applied to the /schedules page: a human typing a cron is not
 * the threat these guard against, and that page documents a two-minute step as
 * its dev default.
 */

/** Refuse anything that could fire twice inside this window. */
export const MIN_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
/** Ceiling on enabled schedules per principal, so a loop can't install hundreds. */
export const MAX_SCHEDULES_PER_PRINCIPAL = 20;

/**
 * Would this cron ever fire twice within `minMs`? Samples the first few
 * occurrences rather than reasoning about the expression: a step of five
 * minutes and `0,1 8 * * *` are both too frequent, and only sampling catches
 * the second. An unparseable expression returns false so the caller rejects it.
 */
export function intervalAtLeast(
  expr: string,
  timezone: string | undefined,
  minMs: number,
): boolean {
  try {
    const cron = new Cron(expr, { timezone: timezone || "UTC" });
    let prev = cron.nextRun(new Date());
    if (!prev) return false; // never fires — nothing to schedule
    for (let i = 0; i < 5; i++) {
      const next = cron.nextRun(prev);
      if (!next) return true; // no further occurrence
      if (next.getTime() - prev.getTime() < minMs) return false;
      prev = next;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check both limits for a would-be agent-created schedule. Returns a message to
 * hand back to the model, or null when it's allowed.
 */
export async function checkScheduleLimits(
  runtime: Runtime<Principal>,
  principal: Principal,
  cron: string | null,
  timezone: string | undefined,
): Promise<string | null> {
  const existing = await runtime.listSchedules({ principal });
  if (existing.filter((s) => s.enabled).length >= MAX_SCHEDULES_PER_PRINCIPAL) {
    return `There are already ${MAX_SCHEDULES_PER_PRINCIPAL} active schedules. Cancel one before adding another.`;
  }
  if (cron && !intervalAtLeast(cron, timezone, MIN_SCHEDULE_INTERVAL_MS)) {
    return (
      "That fires too often (or isn't a valid cron). The minimum interval is 15 minutes — " +
      "try something like `0 8 * * 1-5`."
    );
  }
  return null;
}
