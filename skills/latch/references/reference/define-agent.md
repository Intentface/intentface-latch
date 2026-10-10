<!-- Generated from apps/docs/content/docs/reference/define-agent.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# defineAgent

Every option an agent takes.

Online: https://intentface-latch-docs.vercel.app/docs/reference/define-agent

`defineAgent` declares an agent: its model, instructions and what it may do. Pass a config object, or a function that returns one when the agent depends on who is asking.

```ts
import { defineAgent } from "@intentface/latch-core";

// The same for everyone:
const support = defineAgent({
  model: anthropic("claude-sonnet-4-6"),
  instructions: "You answer support questions.",
  tools: { search_docs, create_ticket },
  toolApproval: { create_ticket: "user-approval" },
});

// Depends on the caller: built per turn from the context.
const assistant = defineAgent(({ context }) => ({
  model: context.plan === "pro" ? anthropic("claude-sonnet-4-6") : anthropic("claude-haiku-4-5"),
  instructions: `You work for ${context.orgName}.`,
}), { title: "Assistant", description: "Answers questions about your account." });
```

## Options

| Option | Type | Description |
| --- | --- | --- |
| `configVersion` (optional) | `number` | Which saved version of a database agent this config came from. Set by agent stores that keep versions; leave it out for agents defined in code. Recorded on every run, so an answer can be traced to the exact configuration that produced it. |
| `model` | `LanguageModel` | The model the agent runs on, as an AI SDK model, for example `anthropic("claude-sonnet-4-6")`. |
| `instructions` (optional) | `string` | The system prompt. |
| `tools` (optional) | `Record<string, unknown>` | Tools available on every turn, as AI SDK `tool()` definitions, by name. |
| `toolSources` (optional) | `ToolSource<P>[]` | Tools that are opened for each turn and closed after it, for example from an MCP server. Each source is opened with the caller's principal, so its tools can act as that person. |
| `connections` (optional) | `string[]` | The connections this agent may use, by name (MCP servers and other integrations from the runtime's `connections`). A connection the user hasn't authorized yet appears as a `connect_<name>` tool that starts its sign-in. Names the runtime doesn't know are ignored. |
| `toolApproval` (optional) | `unknown` | Which tools need a person's approval before they run, by tool name: `{ send_email: "user-approval" }`. A gated call pauses the run and shows an approval request; `runtime.applyApproval` continues it. Same format as the AI SDK's `toolApproval`, including the function form. |
| `smoothStream` (optional) | `boolean \| { delayInMs?: number; chunking?: "word" \| "line"; }` | Evens out the speed of streamed text, so it appears word by word instead of in bursts. `true` uses the AI SDK defaults; pass `delayInMs` or `chunking` to tune it. Only affects display. |
| `maxSteps` (optional) | `number \| "unlimited"` | The most model steps (a step is one model call and the tools it calls) a turn may take before it stops. `"unlimited"` lets the agent run until it stops calling tools; use with care, as nothing then stops a runaway loop. Default: `20`. |
| `enabledTools` (optional) | `string[]` | Limits the agent to these tools, by name (connection tools are prefixed, like `github_create_issue`). Sign-in tools such as `connect_<name>` stay available. Default: `all tools`. |
| `toolDescriptions` (optional) | `Record<string, string>` | Replaces tool descriptions for this agent, by tool name: tailor how a connection's tool is described to the model without changing the tool. |
| `subagents` (optional) | `string[]` | Agents this one can hand work to, by name. The agent gets a `spawn_agent` tool: the other agent runs on its own and its final answer comes back as the tool's result. Each handover is a saved thread the agent can continue with the returned `threadId`. A subagent's approval requests are shown in the parent chat. |
| `sandbox` (optional) | `boolean` | Gives the agent a workspace with files and a shell, one per chat, plus the tools that use it: `bash`, `read_file`, `write_file`, `glob`, `grep`. Needs `sandbox` and `harnessTools` in the runtime config. |
| `sandboxProvider` (optional) | `string` | Which sandbox provider to use, for example `"daytona"`. Passed to the runtime's `sandbox` function, which picks the default. |
| `defaultTools` (optional) | `boolean \| string[]` | Adds the built-in app tools: `web_fetch`, `askUser`, `list_schedules`, `cancel_schedule`. `true` adds all of them; a list adds only those. Needs `harnessTools` in the runtime config. |
| `renderTools` (optional) | `boolean` | Adds tools that open web pages in a real browser, for pages that need JavaScript to show their content. Needs `harnessTools.render`, which you supply with a deployed render service. |
| `disableTools` (optional) | `string[]` | Built-in tools to leave out for this agent, by name. |
| `providerWebTools` (optional) | `boolean` | Uses the model provider's own web search and fetch, run on the provider's side. Anthropic offers search and fetch, OpenAI search only; other providers ignore it. Needs `resolveProviderTools` in the runtime config. |
| `effort` (optional) | `"high" \| "low" \| "medium" \| "minimal"` | How hard a reasoning model thinks before answering. Higher is slower and costs more. Ignored by models that don't reason. Needs `resolveReasoningOptions` in the runtime config. Default: `the provider's default`. |
| `memory` (optional) | `MemoryConfig` | Long-term memory across conversations: what the agent learns is added to its instructions on later turns, and it gets tools to search and save memories. Needs `memory` in the runtime config. **Experimental.** The only production store today is a Loredex workspace, and the design may change. |
| `extensions` (optional) | `Extension[]` | Extensions for this agent's runs, applied after the runtime-wide ones. |

## Params

An agent that's always *about* something declares it in the second argument, with a schema. The chat's first message passes the value; every turn after gets it. When to use params: [Principal, context and params](../concepts/inputs.md#params-what-the-chat-is-about).

```ts
const Ticket = z.object({ ticketId: z.string() });

const support = defineAgent<Principal, Ctx, z.infer<typeof Ticket>>(
  async ({ context, params }) => {
    const ticket = await context.db.tickets.get(params.ticketId);
    return { model, instructions: `You help with ticket ${ticket.id}.`, tools: { reply_to_ticket } };
  },
  { title: "Support", params: Ticket },
);

runtime.handleChat({ agent: "support", chatId, principal, message, params: { ticketId: "T-9" } });
```

Refusals: params that don't match the schema, or sent to an agent without one, get 400 `invalid_params`; different params for an existing chat get 409 `params_fixed`.

## What the function receives

| Option | Type | Description |
| --- | --- | --- |
| `context` | `RuntimeContext` | What your `context` function built for this turn, from the principal: clients, the plan, permissions. |
| `principal` | `P` | Who is asking. |
| `messageContext` (optional) | `unknown` | What the user is looking at, from the `data-context` part of the message being answered (checked against `messageContext.schema` when set). The same on a continuation of that answer; `undefined` when the message has none. |
| `turnContext` (optional) | `unknown` |  |
| `params` (optional) | `Params` | What this chat is about: the params its first message passed, checked against `meta.params`. `undefined` for an agent that declares none. |

## Display, params and message context

The second argument says how the agent appears in a picker, what its chats are about, and how it reads the message's `data-context`:

| Option | Type | Description |
| --- | --- | --- |
| `title` (optional) | `string` | The name shown to users. Default: `the agent's key in `agents``. |
| `description` (optional) | `string` | One line on what the agent does. |
| `hidden` (optional) | `boolean` | Hides the agent from pickers. It still runs when called by name, for example as a subagent. `listAgents()` returns it with this flag set; the HTTP server's agent list leaves it out. |
| `params` (optional) | `FlexibleSchema` | What a chat with this agent is about, as a schema (Zod, Valibot, any Standard Schema): a ticket, a document, a model fixed for the chat. Set on the chat's first message (`handleChat({ params })`, `runAgent`, `schedule`), validated, saved on the chat, and handed to the agent function and its tools on every turn. Most agents need none; an agent without a schema refuses params. Params come from the client. An id in them says which thing the chat is about, not whether the user may see it: load it through something limited to the principal, in the agent function. |
| `messageContext` (optional) | `{ toModel?: (context: any) => string \| undefined; }` | How this agent reads the `data-context` part on user messages, in place of the runtime's `messageContext.toModel`. Return `undefined` to leave it out for this agent. |
