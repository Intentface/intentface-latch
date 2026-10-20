<!-- Generated from apps/docs/content/docs/getting-started/quickstart.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Quickstart

A chat agent that remembers, in one file and five minutes.

Online: https://intentface-latch-docs.vercel.app/docs/getting-started/quickstart

You'll run a small server with one agent, talk to it, and see it remember the conversation.

## 1. Install

```bash
pnpm add @intentface/latch-core @intentface/latch-drizzle @intentface/latch-server \
  ai @ai-sdk/anthropic @libsql/client drizzle-orm hono @hono/node-server
export ANTHROPIC_API_KEY=sk-ant-…
```

## 2. One file

```ts title="server.ts"
import { serve } from "@hono/node-server";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createLatchHonoApp } from "@intentface/latch-server/hono";

type Principal = { userId: string };

const client = createClient({ url: "file:./latch.db" });
await migrate(client);

const { app } = await createLatchHonoApp<Principal>({
  storage: createSqliteAdapter<Principal>(drizzle(client, { schema }), {
    owner: (p) => [p.userId], // each user sees only their own chats
  }),
  // Who is asking. Everyone is one demo user, and only when NODE_ENV is
  // "development": anywhere else it refuses everyone (401) until you read
  // your real session here.
  resolvePrincipal: async () => (process.env.NODE_ENV === "development" ? { userId: "demo" } : null),
  agents: (models) => ({
    assistant: defineAgent<Principal>({
      model: models.modelFor("claude-sonnet-4-6"),
      instructions: "You are a friendly, concise assistant.",
    }),
  }),
});

serve({ fetch: app.fetch, port: 8787 });
```

```bash
NODE_ENV=development npx tsx server.ts
```

## 3. Talk to it

```bash
curl -N localhost:8787/agents/assistant/chat-1 -H 'content-type: application/json' \
  -d '{"text":"Hi! My name is Anna."}'

curl -N localhost:8787/agents/assistant/chat-1 -H 'content-type: application/json' \
  -d '{"text":"What is my name?"}'
```

The second answer knows your name. The conversation is saved in `latch.db`, together with what each answer cost, so it survives a restart.

The answer streams in the AI SDK's format, so a React page served from the same app can use `useChat` as is:

```tsx
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({ api: "/agents/assistant/chat-1" }),
});
```

## What you just got

That one file is already more than a demo:

- **Conversations are saved and scoped per user.** Two tabs can't scramble one chat.
- **Crash recovery is on.** Stop the server in the middle of an answer and start it again: the answer finishes on its own.
- **Costs are recorded** for every answer.

## Next

Each of these takes a few lines on top of this file:

- [Ask before risky actions](https://intentface-latch-docs.vercel.app/docs/hard-parts/approvals): a person approves before a tool runs.
- [Your real users](https://intentface-latch-docs.vercel.app/docs/hard-parts/access): replace the demo user with your login, and decide who sees which chats.
- [Usage limits](https://intentface-latch-docs.vercel.app/docs/hard-parts/limits): requests and tokens per user, per day.
- [Running on many servers](https://intentface-latch-docs.vercel.app/docs/hard-parts/durability): what changes on Vercel or behind a load balancer.
- [Files and images](https://intentface-latch-docs.vercel.app/docs/hard-parts/attachments): what happens when users attach them.
