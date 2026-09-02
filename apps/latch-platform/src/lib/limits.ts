import { DAY_MS, HOUR_MS, MINUTE_MS, type LatchLimits, type LimitPolicy } from "@intentface/latch-core";
import { createSqliteLimitStore } from "@intentface/latch-drizzle";
import type { Principal } from "./session";

/**
 * Platform limits policy: per org, per user and per agent budgets from env,
 * all optional — an unset variable is no cap, and with none set the seam is not
 * wired at all (zero behaviour change).
 *
 *   LATCH_LIMIT_ORG_TOKENS_PER_DAY      tokens an org may spend per day
 *   LATCH_LIMIT_ORG_COST_PER_DAY        cost (USD) an org may spend per day
 *   LATCH_LIMIT_USER_TOKENS_PER_DAY     tokens one member may spend per day
 *   LATCH_LIMIT_USER_TURNS_PER_MINUTE   turns one member may start per minute
 *   LATCH_LIMIT_AGENT_TURNS_PER_HOUR    turns one agent may run per hour (per org)
 *
 * Counters live in `latch_limit_counters` (drizzle). A per-org policy table
 * with a settings UI is the natural next step; the seam is the same.
 */

const num = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

export function platformLimits(db: Parameters<typeof createSqliteLimitStore>[0]): LatchLimits<Principal> | undefined {
  const orgTokensDay = num("LATCH_LIMIT_ORG_TOKENS_PER_DAY");
  const orgCostDay = num("LATCH_LIMIT_ORG_COST_PER_DAY");
  const userTokensDay = num("LATCH_LIMIT_USER_TOKENS_PER_DAY");
  const userTurnsMinute = num("LATCH_LIMIT_USER_TURNS_PER_MINUTE");
  const agentTurnsHour = num("LATCH_LIMIT_AGENT_TURNS_PER_HOUR");
  if (![orgTokensDay, orgCostDay, userTokensDay, userTurnsMinute, agentTurnsHour].some(Boolean)) {
    return undefined;
  }

  return {
    store: createSqliteLimitStore(db),
    limitsFor: ({ principal, agent }) => {
      const policies: LimitPolicy[] = [];
      if (orgTokensDay || orgCostDay) {
        policies.push({
          key: `org:${principal.orgId}`,
          windowMs: DAY_MS,
          max: { ...(orgTokensDay ? { tokens: orgTokensDay } : {}), ...(orgCostDay ? { cost: orgCostDay } : {}) },
          label: "your organization's daily budget",
        });
      }
      // The ACTING human where a channel turn carries one (Slack per-user mode).
      const user = principal.actorUserId ?? principal.userId;
      if (user && userTokensDay) {
        policies.push({
          key: `user:${principal.orgId}:${user}`,
          windowMs: DAY_MS,
          max: { tokens: userTokensDay },
          label: "your daily token budget",
        });
      }
      if (user && userTurnsMinute) {
        policies.push({
          key: `user:${principal.orgId}:${user}:turns`,
          windowMs: MINUTE_MS,
          max: { turns: userTurnsMinute },
          label: "your per-minute message limit",
        });
      }
      if (agentTurnsHour) {
        policies.push({
          key: `agent:${principal.orgId}:${agent}`,
          windowMs: HOUR_MS,
          max: { turns: agentTurnsHour },
          label: `the hourly run limit for ${agent}`,
        });
      }
      return policies;
    },
    onRefused: ({ principal, agent, trigger, policy }) => {
      console.warn(`[limits] refused ${trigger} turn of ${agent} for ${principal.orgId}: ${policy.key}`);
    },
  };
}
