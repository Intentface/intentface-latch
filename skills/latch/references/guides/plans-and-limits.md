<!-- Generated from apps/docs/content/docs/guides/plans-and-limits.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Plans and limits

Give each plan its own caps on requests, tokens and cost, per team, person and agent, and tell users which one they hit.

Online: https://intentface-latch-docs.vercel.app/docs/guides/plans-and-limits

The free plan gets 20 requests a day per person. The team plan gets a monthly token budget for the whole team. The expensive research agent gets its own cost cap. Here's how to set that up. For why it's harder than reading a counter, see [Usage limits](https://intentface-latch-docs.vercel.app/docs/hard-parts/limits).

## 1. Say which limits a run counts against

`limitsFor` runs before every run and returns the limits it counts against. Each has a key (any string: a team, a person, an agent, an API key), a window, and caps on `turns`, `tokens` and `cost`.

```ts
import { DAY_MS, MINUTE_MS } from "@intentface/latch-core";
import { createPostgresLimitStore } from "@intentface/latch-drizzle";

createRuntime({
  …,
  limits: {
    store: createPostgresLimitStore(db), // one counter row per key and window
    limitsFor: async ({ principal, agent }) => {
      const plan = await planOf(principal.orgId); // your table: keep it fast, it runs every time
      return [
        { key: `org:${principal.orgId}`, windowMs: 30 * DAY_MS, max: { tokens: plan.monthlyTokens }, label: "your team's monthly budget" },
        { key: `user:${principal.orgId}:${principal.userId}`, windowMs: DAY_MS, max: { turns: plan.dailyRequests }, label: "your daily requests" },
        { key: `user:${principal.orgId}:${principal.userId}`, windowMs: MINUTE_MS, max: { turns: 10 } },
        ...(agent === "research" ? [{ key: `agent:${principal.orgId}:research`, windowMs: DAY_MS, max: { cost: 20 } }] : []),
      ];
    },
  },
});
```

Return an empty list and the run isn't limited at all.

## 2. Treat background runs differently

`trigger` says how the run started: `"chat"`, `"schedule"`, `"programmatic"` (a `runAgent` call), `"decision"` (continuing after an approval) or `"resume"` (after a crash). A scheduled report probably shouldn't use up a person's daily requests:

```ts
limitsFor: ({ principal, trigger }) =>
  trigger === "schedule"
    ? [{ key: `schedules:${principal.orgId}`, windowMs: DAY_MS, max: { cost: 5 } }]
    : chatLimits(principal),
```

Subagents count against the limits of the run that started them, with the same trigger.

## 3. Tell the user which limit they hit

A refused run throws `LimitExceededError` before the chat or the message is saved. (The refused attempt's place in the window is given back; if that fails, it counts once against the limit.) Its message names the limit by its `label` and says when it resets: "Limit reached: your daily requests. Try again in 3 hours." `createLatchHandler` turns it into `429` with `Retry-After`; in your own route, do the same:

```ts
import { isLimitExceededError } from "@intentface/latch-core";

try {
  return await runtime.handleChat({ … });
} catch (e) {
  if (isLimitExceededError(e)) {
    return Response.json({ error: e.message }, {
      status: 429,
      headers: { "retry-after": String(Math.ceil(e.retryAfterMs / 1000)) },
    });
  }
  throw e;
}
```

## Good to know

- **Windows are fixed and aligned to UTC.** A day runs from 00:00 to 00:00 UTC, not the user's midnight. A 30-day window is 30 days from a fixed point, not a calendar month.
- **Request limits are exact, token and cost limits can overshoot** by what answers already running spend. See [what holds exactly](https://intentface-latch-docs.vercel.app/docs/hard-parts/limits).
- **A long answer stops at the budget,** keeping what it wrote.
- **Old counters are cleaned up** by `runtime.cron()`.
