<!-- Generated from apps/docs/content/docs/reference/context.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Context and tools

The context function, and everything a tool receives as options.context.

Online: https://intentface-latch-docs.vercel.app/docs/reference/context

What these are for, and when to use which: [Principal, context and params](../concepts/inputs.md).

## The context function

```ts
export const context = async ({ principal }: { principal: Principal }) => ({
  db: dbFor(principal.orgId),
  plan: await planOf(principal.orgId),
});
export type Ctx = Awaited<ReturnType<typeof context>>;

createRuntime({ storage, context, agents });
```

- **Called** at the start of every turn: new messages, the continuation after an approval, crash recovery, schedule fires, subagent runs.
- **Gets** only the principal. That's all Latch has when an answer continues without a request.
- **Never saved**, so it can return clients and functions, and always reads current values.
- **Optional.** Without it, the context is `{}`.

The `{ build }` object from `defineContext` still works but is deprecated: its `request` and `turnContext` are missing whenever an answer continues.

## What a tool receives

Every tool gets what the context function returned, plus what Latch adds, as `options.context`:

```ts
import type { ToolContext } from "@intentface/latch-core";

execute: async ({ reason }, { context }) => {
  const { db, principal, params, messageContext } = context as ToolContext<Principal, Ctx, TicketParams, View>;
  return db.tickets.close(params.ticketId, { by: principal.userId, reason });
},
```

`ToolContext<Principal, Ctx, Params, MessageContext>` is that shape. The cast is still needed: the AI SDK can only infer a tool's context type from a `contextSchema`.

| Option | Type | Description |
| --- | --- | --- |
| `principal` | `P` | Who the run is for: the principal your route passed, or the one restored for a resumed or scheduled run. |
| `run` | `{ id: string; chatId: string; agent: string; }` | The run this tool call belongs to. `agent` is the agent's name as the run resolved it. |
| `writer` | `TurnWriter` | Streams extra parts (for example `data-*` progress) into the answer while the tool runs. |
| `runtime` | `Runtime<P>` | The runtime itself, for tools that schedule, list chats or start runs. |
| `params` | `Params` | What this chat is about (see `defineAgent`'s `params`), or `undefined` for an agent that declares none. Sent by the client: look ids up through something limited to `principal` before trusting them. |
| `messageContext` | `MessageContext` | What the user is looking at, from the `data-context` part of the message being answered; `undefined` when it has none. Sent by the client, like `params`: describes, never authorizes. |

A field your context function returns with one of these names is replaced by Latch's.

## What the agent function receives

| Option | Type | Description |
| --- | --- | --- |
| `context` | `RuntimeContext` | What your `context` function built for this turn, from the principal: clients, the plan, permissions. |
| `principal` | `P` | Who is asking. |
| `messageContext` (optional) | `unknown` | What the user is looking at, from the `data-context` part of the message being answered (checked against `messageContext.schema` when set). The same on a continuation of that answer; `undefined` when the message has none. |
| `turnContext` (optional) | `unknown` |  |
| `params` (optional) | `Params` | What this chat is about: the params its first message passed, checked against `meta.params`. `undefined` for an agent that declares none. |
