<!-- Generated from apps/docs/content/docs/getting-started/by-hand.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# By hand

createRuntime piece by piece — storage, context, agents — then durability and a cron, one option at a time.

Online: https://intentface-latch-docs.vercel.app/docs/getting-started/by-hand

`createLatchApp` fills in every default. This page is the same backend assembled from its parts, so you can see what each default is and swap any of them.

## Tier 1 — a persisted runtime

Storage is the one option you can't leave out. `latch-drizzle` ships adapters for SQLite and Postgres, plus the migrations.

```ts title="latch.ts"
import { createRuntime, defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

interface Principal {
  orgId: string;
  userId?: string;
}

const client = createClient({ url: "file:local.db" });
const db = drizzle(client, { schema });

// `migrate` executes DDL, so it takes the libSQL client — not the drizzle db.
await migrate(client);

// The owner key is your isolation boundary — see /docs/guides/ownership-patterns.
const storage = createSqliteAdapter<Principal>(db, {
  owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]),
});

// What tools work with, built from who is asking on every turn.
const context = async ({ principal }: { principal: Principal }) => ({ orgId: principal.orgId });

const agents = {
  assistant: defineAgent<Principal>(() => ({
    model: anthropic("claude-sonnet-4-6"),
    instructions: "You are a concise, helpful assistant.",
  })),
};

export const runtime = createRuntime<Principal, { orgId: string }>({ storage, context, agents });
```

Run a turn:

```ts
const response = await runtime.handleChat({
  agent: "assistant",
  principal: { orgId: "acme", userId: "u_1" },
  message: {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: "Hello." }],
  },
});
```

`handleChat` returns a `Response` streaming AI SDK UI message parts — hand it straight back from your route, or read it yourself.

Tables are prefixed `latch_*`. Consume the package's migrations rather than hand-declaring the schema in your own migration folder.

## Tier 2 — make it durable

One option and one route. The runtime gets `durability`, and something has to tick:

```ts
import { Cron } from "croner";

export const runtime = createRuntime<Principal, { orgId: string }>({
  storage,
  context,
  agents,
  durability: { enabled: true },
  // Schedules need a cron evaluator; core ships none.
  cron: (expr, afterMs, timezone) =>
    new Cron(expr, { timezone: timezone ?? "UTC" }).nextRun(new Date(afterMs))?.getTime() ?? null,
});

// The whole operational surface. A platform cron hits this route; guard it.
export async function POST(request: Request) {
  assertCronSecret(request);
  return Response.json(await runtime.cron());
}
```

A run that dies mid-turn is now reaped on the next tick and resumed from its own log. On a long-lived process, `createIntervalScheduler` drives the same call in-process — see [Turn on crash recovery](../guides/crash-recovery.md).

## Tier 0 — stateless

The same code with `createClient({ url: ":memory:" })`: a fresh database per process, nothing persisted past it. Useful for a serverless function that answers one turn, and for tests.

## Mount it

`createLatchHandler({ runtime, resolvePrincipal })` gives you the Web-standard handler; [Hosting](../guides/mount-the-handler.md) mounts it in Hono, Express, Fastify, NestJS or any framework that speaks `Request` and `Response`.

## Next

- [createRuntime](../reference/create-runtime.md) and [Runtime methods](../reference/runtime.md) — every option and operation
- [Hooks](https://intentface-latch-docs.vercel.app/docs/reference/hooks) — why everything past tier 0 is a function you pass
