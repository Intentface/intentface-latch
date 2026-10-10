---
name: latch
description: Build AI agent backends with Latch (@intentface/latch-* packages, on the Vercel AI SDK). Use when writing or changing code that imports @intentface/latch-core, -server, -drizzle, -mcp or -channels; when deciding what goes in the principal, context, params or a data-context part; or when adding tools, approvals, crash recovery, usage limits, schedules, storage, MCP connections, secrets or Slack/Telegram/WhatsApp to an agent.
---

# Building with Latch

Latch is the backend around an AI SDK agent: saved conversations, approvals
that wait for a person, answers that survive a crashed server, per-customer
isolation, usage limits, schedules and chat apps. It is a library that runs in
the user's own server, on their Postgres or SQLite, behind their own login.

Written for Latch **0.17**. The `references/` folder next to this file holds the
docs pages for this version as markdown; read the one for the task before
writing code. This file holds the recipes and the rules that are easy to get
wrong. Latest docs online: https://intentface-latch-docs.vercel.app/docs
(append `.md` to any page for its markdown; `/llms.txt` lists every page).

## The shape of an integration

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { createRuntime, defineAgent } from "@intentface/latch-core";
import { createPostgresAdapter } from "@intentface/latch-drizzle";

type Principal = { orgId: string; userId: string }; // ids only

export const runtime = createRuntime<Principal>({
  storage: createPostgresAdapter(db, { owner: (p) => [p.orgId, p.userId] }),
  context: ({ principal }) => ({ orders: ordersFor(principal.orgId) }),
  agents: {
    support: defineAgent({
      model: anthropic("claude-sonnet-4-6"),
      instructions: "You help customers with their orders.",
      tools: { find_order, refund },
      toolApproval: { refund: "user-approval" },
    }),
  },
  durability: { enabled: true },
});

// The route: your login decides the principal, Latch does the rest.
export async function POST(req: Request) {
  const user = await requireUser(req);
  const { id, message } = await req.json();
  return runtime.handleChat({
    agent: "support",
    chatId: id,
    principal: { orgId: user.orgId, userId: user.id },
    message,
  });
}
```

`createLatchApp` / `createLatchHonoApp` (`@intentface/latch-server`) wire the
runtime, HTTP routes, model catalog and cron in one call; `createRuntime` plus
your own route gives you control over each.

## How to build

### A chat agent that remembers

One file with `createLatchHonoApp`, a SQLite adapter and `migrate(client)`.
Conversations are saved per user, crash recovery is on and costs are recorded.
Read [the quickstart](references/getting-started/quickstart.md); packages and
peers are in [install](references/getting-started/install.md).

### Your own route and the chat UI

Call `runtime.handleChat` from your route (above), or mount the handler with
`createLatchHandler` in Next.js, Hono, TanStack Start or Bun. The client is the
AI SDK's `useChat`; send only the last message:

```tsx
const { messages, sendMessage, addToolApprovalResponse } = useChat({
  id: chatId,
  transport: new DefaultChatTransport({
    api: "/api/chat",
    prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
  }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});
```

Read [the chat UI](references/guides/chat-ui.md),
[mount the handler](references/guides/mount-the-handler.md) and
[without createLatchApp](references/getting-started/by-hand.md).

### Tools that only reach the user's data

Build data access bound to the org in `context`; tools get it, plus the
principal, through `options.context`:

```ts
export const context = ({ principal }: { principal: Principal }) => ({
  orders: ordersFor(principal.orgId),
});
type Ctx = ToolContext<Principal, ReturnType<typeof context>>;

export const find_order = tool({
  description: "Look up an order",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, { context }) => (context as Ctx).orders.get(orderId),
});
```

Read [agents](references/concepts/agents.md),
[tools and connections](references/concepts/tools-connections.md) and
[context and tools](references/reference/context.md).

### Ask before a tool runs

`toolApproval: { refund: "user-approval" }` on the agent. The answer pauses,
the pending call is saved, and the decision can come later, from another device
or Slack; it runs once. With `useChat`, `addToolApprovalResponse` plus
`sendAutomaticallyWhen` above is the whole client.
Read [approvals](references/guides/approvals.md).

### Real users, and who sees which chats

The route's login decides the principal; the adapter's `owner` decides which
chats a principal can see (private, shared per org, team chats). Set
`reconstructPrincipal` so runs without a request re-check the saved user.
Read [ownership patterns](references/guides/ownership-patterns.md) and
[agents for your customers' users](references/guides/agent-for-your-customers.md).

### Per-chat subject, or what the user is looking at

A ticket or document a chat is about is `params` (declared on the agent with a
schema, sent with the first message). The open file or selection is a
`data-context` part on each message. See "What to pass where" below and
[Principal, context and params](references/concepts/inputs.md).

### Schedules and background runs

```ts
await runtime.schedule({
  principal,
  agent: "reporter",
  cron: "0 9 * * 1", // null = one-shot
  timezone: "Europe/Helsinki",
  prompt: "Summarise last week's signups.",
});
```

`createRuntime` needs a `cron` evaluator (`createCronerEvaluator()` from
`@intentface/latch-server`), and something must call `runtime.cron()`
regularly. `runtime.runAgent({ principal, agent, prompt })` runs one now,
without a chat. Read [schedules](references/guides/schedules.md).

### Connect MCP servers and other accounts

```ts
import { createMcpConnections, oauth } from "@intentface/latch-mcp";

createRuntime({
  …,
  connections: createMcpConnections({
    vault,
    allowedHosts: ["mcp.linear.app"],
    callbackBaseUrl: "https://app.example.com/api/latch/connections",
    connections: { linear: { url: "https://mcp.linear.app/mcp", auth: oauth() } },
  }),
});
defineAgent({ …, connections: ["linear"] });
```

`oauth()` uses dynamic client registration; most providers that don't support
it need `oauth({ clientId, clientSecret })`. Tokens and API keys live in the
vault (`createVault` with a store and a 32-byte `masterKey`).
Read [connections](references/guides/connections.md) and
[secrets](references/concepts/secrets.md).

### Usage limits per plan

```ts
limits: {
  store: createPostgresLimitStore(db),
  limitsFor: async ({ principal }) => {
    const plan = await planOf(principal.orgId);
    return [
      { key: `org:${principal.orgId}`, windowMs: 30 * DAY_MS, max: { tokens: plan.monthlyTokens } },
      { key: `user:${principal.orgId}:${principal.userId}`, windowMs: DAY_MS, max: { turns: plan.dailyRequests } },
    ];
  },
},
```

A refused run throws `LimitExceededError` (429 with `Retry-After` from the
handler). Read [plans and limits](references/guides/plans-and-limits.md).

### Slack, Telegram, WhatsApp

`@intentface/latch-channels/slack`, `/telegram`, `/whatsapp`: one webhook
route per bot, approvals as buttons, identity linking. You supply the channel
store. Read [channels](references/concepts/channels.md) and
[the channels guide](references/guides/channels.md).

### Deploy on Vercel or many servers

`durability: { enabled: true }`, `maxDuration` on the chat and cron routes, a
GET cron route that checks `CRON_SECRET` and calls `runtime.cron()`, and
`vercel.json` crons. Read [deploy on Vercel](references/guides/deploy-on-vercel.md)
and [crash recovery](references/guides/crash-recovery.md).

### More

- Agents stored in a database, editable by users: [agents in a database](references/guides/agents-in-a-database.md)
- Your own storage: [write a storage adapter](references/guides/storage-adapter.md) (must pass `registerStorageConformance` from `@intentface/latch-core/testing`); the built-in ones: [storage](references/concepts/storage.md)
- Hooks into a turn: [write an extension](references/guides/write-an-extension.md)

## What to pass where

An agent gets four inputs. Each lives for a different length of time, and
putting something in the wrong one breaks quietly, usually after an approval
or a crash, when the answer continues without your route running.

| Input | Answers | Lives | Set by |
| --- | --- | --- | --- |
| `principal` | Who is asking? | saved with every chat, run and schedule | your route, from your login |
| `context` | What can they work with? | rebuilt at the start of every turn | `createRuntime({ context: ({ principal }) => … })` |
| `params` | What is this chat about? | saved on the chat, fixed for its life | the chat's first `handleChat`, or `runAgent` / `schedule` |
| `data-context` | What are they looking at now? | saved with that one message | the client, as a part on the user's message |

- **principal**: ids only. Storage scopes every read and write by it (through
  the adapter's `owner`), limits key from it, and it is saved, so a resumed
  answer or a 9:00 schedule still acts as the right person.
- **context**: a plain function of the principal only. Clients bound to the
  user's org, their plan, feature flags. Never read the request here: there is
  none when an answer continues.
- **params**: declared per agent with a schema, `defineAgent(fn, { params: Schema })`.
  Sent once; the same params again are fine, different ones are refused
  (409 `params_fixed`); a new subject means a new chat. Most agents need none.
- **data-context**: `{ type: "data-context", data: {...} }` on the user's
  message. The model reads it as text in that message, so the system prompt
  never changes and prompt caching keeps working. Max 32 KB.

The agent function receives `{ principal, context, params, messageContext }`;
tools receive the same through `options.context`, typed with
`ToolContext<Principal, Ctx, Params>`.

| Mistake | Instead |
| --- | --- |
| A plan or role in the principal (frozen into saved runs) | Look it up in `context` |
| What the user is looking at in `instructions` (breaks the cache) | A `data-context` part |
| Reading the request in `context` or the agent function | Read it in the route; pass `params` or `data-context` |
| Trusting an id from `params` or `data-context` | Load it through the user's own client; treat it as a claim |
| A secret in `params` or `data-context` (stored, sent to the model) | Fetch it inside the tool, from the vault |
| `turnContext` / `request` (deprecated: gone after an approval) | The four inputs above |

Read [Principal, context and params](references/concepts/inputs.md).

## Rules that fail silently

- **Keep the owner key stable.** `owner: (p) => [...]` is what scopes data. If
  a value in it can change mid-session (an "active org" the user switches),
  older chats belong to a key the user no longer has. Pin it when the session
  is created.
- **Tools with side effects must be safe to run twice.** Crash recovery resumes
  from the last finished step; a tool that was mid-run may run again. Check
  whether the action already happened, or pass an idempotency key.
- **Isolation lives in the tools' data access.** Give tools a client already
  bound to `principal.orgId` through `context`, never an org id from the model
  or the request.
- **MCP tools are gated only when marked.** Approval follows a tool's
  `destructiveHint` / `readOnlyHint`; servers don't always set them, so ask for
  approval on every tool when unsure.
- **Without a request, `reconstructPrincipal` decides.** Resumed answers and
  schedules re-check the saved principal through it; return `null` for a user
  who has left.
- **Serverless needs a cron.** Without one, schedules never fire and
  interrupted answers are never finished.
- **Token and cost limits can be overrun.** Request limits (`turns`) hold
  exactly; token and cost caps are checked against what's already recorded, so
  answers still running can go past them. Leave a margin.
- **The vault's master key can't be rotated yet.** Lose or change it and every
  stored secret is unreadable.
- **Memory is experimental.** `memory` options and `@intentface/latch-memory`
  may change in any release; don't build on them unless asked.

## References

| Area | Files |
| --- | --- |
| Start | [quickstart](references/getting-started/quickstart.md), [install](references/getting-started/install.md), [without createLatchApp](references/getting-started/by-hand.md) |
| Concepts | [inputs](references/concepts/inputs.md), [agents](references/concepts/agents.md), [tools and connections](references/concepts/tools-connections.md), [secrets](references/concepts/secrets.md), [storage](references/concepts/storage.md), [channels](references/concepts/channels.md) |
| Guides | [chat UI](references/guides/chat-ui.md), [mount the handler](references/guides/mount-the-handler.md), [approvals](references/guides/approvals.md), [schedules](references/guides/schedules.md), [connections](references/guides/connections.md), [channels](references/guides/channels.md), [plans and limits](references/guides/plans-and-limits.md), [crash recovery](references/guides/crash-recovery.md), [deploy on Vercel](references/guides/deploy-on-vercel.md), [ownership patterns](references/guides/ownership-patterns.md), [agents for your customers](references/guides/agent-for-your-customers.md), [agents in a database](references/guides/agents-in-a-database.md), [storage adapter](references/guides/storage-adapter.md), [extensions](references/guides/write-an-extension.md) |
| API | [createRuntime](references/reference/create-runtime.md), [defineAgent](references/reference/define-agent.md), [context and tools](references/reference/context.md), [runtime methods](references/reference/runtime.md), [server](references/reference/server.md), [vault](references/reference/vault.md), [errors](references/reference/errors.md) |
