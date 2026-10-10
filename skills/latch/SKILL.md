---
name: latch
description: Build AI agent backends with Latch (@intentface/latch-* packages, on the Vercel AI SDK). Use when writing or changing code that imports @intentface/latch-core, -server, -drizzle, -mcp or -channels; when deciding what goes in the principal, context, params or a data-context part; or when adding approvals, crash recovery, usage limits, schedules, storage adapters, MCP connections or Slack/Telegram/WhatsApp to an agent.
---

# Building with Latch

Latch is the backend around an AI SDK agent: saved conversations, approvals
that wait for a person, answers that survive a crashed server, per-customer
isolation, usage limits, schedules and chat apps. It is a library that runs in
the user's own server, on their Postgres or SQLite, behind their own login.

Written for Latch **0.17**. Docs: https://intentface-latch-docs.vercel.app/docs.
Append `.md` to any docs URL for its Markdown; `/llms.txt` lists every page.
Fetch the page for the task at hand before writing code; this file holds the
rules that are easy to get wrong, not the full API.

## The shape of an integration

```ts
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
  return runtime.handleChat({ agent: "support", chatId: id, principal: { orgId: user.orgId, userId: user.id }, message });
}
```

The client is the AI SDK's own `useChat` with a `DefaultChatTransport`; send
only the last message (`prepareSendMessagesRequest`). Approvals use
`addToolApprovalResponse` and `lastAssistantMessageIsCompleteWithApprovalResponses`.
`createLatchApp` / `createLatchHonoApp` (`@intentface/latch-server`) wire the
runtime, routes, model catalog and cron in one call; use `createRuntime` plus
your own route when you need control.

Pages: [quickstart](https://intentface-latch-docs.vercel.app/docs/getting-started/quickstart.md),
[chat UI](https://intentface-latch-docs.vercel.app/docs/guides/chat-ui.md),
[createRuntime](https://intentface-latch-docs.vercel.app/docs/reference/create-runtime.md).

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

Page: [Principal, context and params](https://intentface-latch-docs.vercel.app/docs/concepts/inputs.md).

## Rules that fail silently

- **Keep the owner key stable.** `owner: (p) => [...]` is what scopes data. If
  a value in it can change mid-session (an "active org" the user switches),
  older chats belong to a key the user no longer has. Pin it when the session
  is created. [Who sees what](https://intentface-latch-docs.vercel.app/docs/hard-parts/access.md)
- **Tools with side effects must be safe to run twice.** Crash recovery resumes
  from the last finished step; a tool that was mid-run may run again. Check
  whether the action already happened, or pass an idempotency key.
  [Crash recovery](https://intentface-latch-docs.vercel.app/docs/hard-parts/durability.md)
- **Isolation lives in the tools' data access.** Give tools a client already
  bound to `principal.orgId` through `context`, never an org id from the model
  or the request.
- **Approvals pause the answer.** `toolApproval: { tool: "user-approval" }`
  saves the pending call; the decision can come later, from another device or
  Slack, and runs once. MCP tools are gated only when annotated destructive or
  not read-only. [Approvals](https://intentface-latch-docs.vercel.app/docs/guides/approvals.md)
- **Without a request, `reconstructPrincipal` decides.** Resumed answers and
  schedules re-check the saved principal through it; return `null` for a user
  who has left. [Deploy on Vercel](https://intentface-latch-docs.vercel.app/docs/guides/deploy-on-vercel.md)
- **Serverless needs a cron.** On Vercel, add a GET route that checks
  `CRON_SECRET` and calls `runtime.cron()`, plus `vercel.json` crons. It fires
  schedules and finishes interrupted answers. Set `maxDuration` on the chat and
  cron routes.
- **Token and cost limits can be overrun.** Request limits (`turns`) hold
  exactly; token and cost caps are checked against what's already recorded, so
  answers still running can go past them. Leave a margin.
  [Usage limits](https://intentface-latch-docs.vercel.app/docs/hard-parts/limits.md)
- **Memory is experimental.** `memory` options and `@intentface/latch-memory`
  may change in any release; don't build on them unless asked.

## Storage

`@intentface/latch-drizzle` ships Postgres and SQLite adapters plus `migrate`.
Run migrations on deploy. A custom adapter must pass the conformance suite
(`registerStorageConformance` from `@intentface/latch-core/testing`).
[Write your own adapter](https://intentface-latch-docs.vercel.app/docs/guides/storage-adapter.md)

## Where to look next

| Task | Page |
| --- | --- |
| Tools, MCP, OpenAPI, OAuth accounts | [connections](https://intentface-latch-docs.vercel.app/docs/guides/connections.md) |
| Secrets for tools | [vault](https://intentface-latch-docs.vercel.app/docs/concepts/secrets.md) |
| Agents for your customers' users (B2B2C) | [guide](https://intentface-latch-docs.vercel.app/docs/guides/agent-for-your-customers.md) |
| Plans and limits | [guide](https://intentface-latch-docs.vercel.app/docs/guides/plans-and-limits.md) |
| Schedules and background runs | [guide](https://intentface-latch-docs.vercel.app/docs/guides/schedules.md) |
| Slack, Telegram, WhatsApp | [guide](https://intentface-latch-docs.vercel.app/docs/guides/channels.md) |
| Hooks into a turn | [extensions](https://intentface-latch-docs.vercel.app/docs/guides/write-an-extension.md) |
| Every option and method | [reference](https://intentface-latch-docs.vercel.app/docs/reference/runtime.md) |
| Error codes | [errors](https://intentface-latch-docs.vercel.app/docs/reference/errors.md) |
