<!-- Generated from apps/docs/content/docs/reference/create-runtime.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# createRuntime

Every option createRuntime takes, with what it does and what happens without it.

Online: https://intentface-latch-docs.vercel.app/docs/reference/create-runtime

`createRuntime(config)` builds the runtime: the object your server calls to run chat turns, apply approvals, resume crashed runs and fire schedules. Create it once per process and reuse it.

```ts
import { createRuntime, defineAgent } from "@intentface/latch-core";
import { createPostgresAdapter } from "@intentface/latch-drizzle";

export const runtime = createRuntime<Principal>({
  storage: createPostgresAdapter(db, { owner: (p) => [p.orgId, p.userId] }),
  context: ({ principal }) => ({ orgId: principal.orgId }),
  agents: {
    support: defineAgent({ model: anthropic("claude-sonnet-4-6"), instructions: "…" }),
  },
});
```

Only `storage` and `agents` are required. Every other option switches a capability on; leave it out and that capability doesn't exist. Click a row to see its full type and description.

## Options

| Option | Type | Description |
| --- | --- | --- |
| `storage` | `StorageAdapter<P>` | Where conversations, runs, usage and schedules are stored. Use `createSqliteAdapter` or `createPostgresAdapter` from `@intentface/latch-drizzle`, or your own adapter (check it with `registerStorageConformance` from `@intentface/latch-core/testing`). |
| `context` (optional) | `ContextInput<P, RuntimeContext>` | What your agents and tools can work with, built from who is asking at the start of every turn, including resumed runs, approvals and schedule fires: `async ({ principal }) => ({ db: dbFor(principal.orgId), … })`. Never saved, so it can hold clients and functions and always reads current values. Optional. The `{ build }` object from `defineContext` still works but is deprecated. |
| `messageContext` (optional) | `{ schema?: FlexibleSchema; toModel?: (context: any) => string \| undefined; }` | What the user is looking at, sent as a `data-context` part on their message (the open file, the selection, a model pick). The model reads it as text in that message; chat UIs don't show it; agent functions and tools get the latest one as `messageContext`. It's saved with its message, so a continuation of the answer sees the same values, and the instructions stay the same between messages, which keeps prompt caching working. Works without configuration. `schema` checks the part when a message arrives (a mismatch is refused, 400); `toModel` decides how it reads to the model (default: a `[Context]` block of `key: value` lines). An agent can override `toModel` in its own `defineAgent` meta. |
| `agents` | `Record<string, AgentFactory<P, any, any>>` | Your agents, by name: `{ support: defineAgent({ … }) }`. The name is what clients send to pick an agent. Agents created by users at runtime come from `dynamicAgents` instead. |
| `durability` (optional) | `DurabilityConfig` | Crash recovery: a run cut off by a crash or redeploy is finished by another server, and no two servers work on the same run at once. Without it, a crashed run stays unfinished until the user sends another message. |
| `pricing` (optional) | `Pricing` | Prices per model, so each run records what it cost. Needed for cost-based limits and usage reports. `providerDefaults` from `@intentface/latch-core/models` supplies it from a model catalog. Without it, every run's cost is recorded as 0. |
| `connections` (optional) | `ConnectionRegistry<P>` | Turns the names in an agent's `connections: [...]` into tools, typically MCP servers. Use `createMcpConnections` from `@intentface/latch-mcp`. Without it, an agent's `connections` are ignored. |
| `dynamicAgents` (optional) | `DynamicAgentStore<P>` | Agents that live in a database rather than in code, such as agents your users create in a UI. Looked up by name, per caller, when a name isn't in `agents`. The Agent Builder's store (`createPostgresAgentBuilderStore` or `createSqliteAgentBuilderStore` from `@intentface/latch-drizzle`) provides `resolve` and `list`. Without it, only the agents in `agents` exist. |
| `memory` (optional) | `MemoryProvider<P>` | Long-term memory for agents that declare `memory`: what they learned is added to their instructions, and they get tools to search and save it. Use `createMemoryProvider` from `@intentface/latch-memory`. **Experimental.** The only production store today is a Loredex workspace, and the design may change. Without it, an agent's `memory` setting is ignored. |
| `reconstructPrincipal` (optional) | `ReconstructPrincipal<P>` | Rebuilds the caller's principal when nobody is there to send a request: a scheduled run firing, or a crashed run being resumed. Use it to re-check that the person still has access. Return `null` to refuse, which stops the schedule or ends the run. Without it, the principal stored when the run or schedule was created is used as it is, unchecked. Default: `(identity) => identity`. |
| `cron` (optional) | `((expr: string, afterMs: number, timezone?: string) => number \| null)` | Works out the next time a cron expression fires, so recurring schedules can run. Wire a cron library, for example `(expr, after, tz) => new Cron(expr, { timezone: tz }).nextRun(new Date(after))?.getTime() ?? null` with `croner`. Without it, only one-off schedules can be created. |
| `runSchedule` (optional) | `((input: { schedule: ScheduleRecord; principal: P; }) => Promise<boolean \| { handled: boolean; chatId?: string; parked?: boolean; }>)` | Runs a scheduled fire yourself, for example to post the result into a Slack channel or a Telegram chat instead of a new web chat. Return `true` when you handled it; return `false` to let Latch run it in a new chat as usual (a stale or missing target, say). A throw, or a result that's neither, counts as an error for that occurrence and nothing else runs, since the hook may already have done the work: once you've delivered, return `true` even if a later step fails. Return `{ handled: true, chatId, parked }` to tell Latch which chat the fire ran in and whether it is waiting on a person; schedules that skip a fire while the previous one waits need that. Without it, every scheduled fire runs in a new chat. |
| `sandbox` (optional) | `((args: { principal: P; chatId: string; agent: string; provider?: string; }) => Experimental_SandboxSession \| Promise<Experimental_SandboxSession>)` | Provides a sandbox (a workspace with files and a shell) for agents that set `sandbox: true`, one per chat. Return an AI SDK `Experimental_SandboxSession` from any provider: a simulated shell, a Daytona VM, and so on. Without it, `sandbox: true` on an agent has no effect. |
| `harnessTools` (optional) | `{ sandbox?: Record<string, unknown>; app?: Record<string, unknown> \| ((args: { principal: unknown; chatId: string; agent: string; }) => Record<string, unknown> \| Promise<Record<string, unknown>>); render?: Record<string, unknown>; approval?: Record<string, unknown>; }` | Built-in tools to offer agents: shell and file tools that work in the sandbox, and app tools such as web fetch, asking the user a question and scheduling. `defaultHarnessTools()` from `@intentface/latch-core/harness` gives you the standard set. Each agent picks them up through its `sandbox` and `defaultTools` settings. |
| `resolveProviderTools` (optional) | `((modelId: string) => Record<string, unknown>)` | Returns the model provider's own web tools (its server-side search and fetch) for a model id, for agents that set `providerWebTools`. Return `{}` for a provider without them. `providerDefaults` supplies it. |
| `resolveReasoningOptions` (optional) | `((modelId: string, effort: string) => { providerOptions?: Record<string, unknown>; maxOutputTokens?: number; } \| undefined)` | Turns an agent's `effort` setting into the provider-specific reasoning options for a model. Return `undefined` to leave the provider's default, for example for a model that doesn't reason. `providerDefaults` supplies it. Without it, `effort` on an agent has no effect. |
| `resolvePromptCaching` (optional) | `((modelId: string, args: { agent: string; memoryScoped: boolean; principal: P; }) => PromptCachingPlan \| undefined)` | Controls prompt caching per model. Return `undefined` for a model to turn caching off for it. `memoryScoped` is true when the system prompt differs per person (an agent with memory), which matters for how OpenAI routes its cache. Without it, caching is on for Anthropic and OpenAI models, which can cut the cost of tool-heavy agents several times over. Turn it off everywhere with `resolvePromptCaching: () => undefined`, or for one run with `promptCaching: false`. |
| `telemetry` (optional) | `LatchTelemetry<P>` | Observes runs: tracing, per-step and per-run callbacks. Use `@intentface/latch-langfuse` for full tracing, or only the callbacks you need (usage dashboards, alerts when a scheduled run waits on a person). Subagent runs are reported too. Without it, nothing is observed. |
| `onOwnerKeyMismatch` (optional) | `((event: { error: OwnerKeyMismatchError; during: "resume" \| "schedule" \| "turn"; runId?: string; scheduleId?: string; }) => void \| Promise<void>)` | Called when the storage adapter refuses a call because its owner key doesn't match the row (`OwnerKeyMismatchError`). Latch never retries it; crash recovery and schedule firing leave that run or schedule alone, so an interrupted answer stays unfinished until someone looks. Send it to your alerting. It also appears in `cron()`'s `errors`. Without it, the mismatch is logged and nothing else happens. |
| `limits` (optional) | `LatchLimits<P>` | Usage limits per organization, user and agent: requests, tokens and cost per time window. You decide which limits a run counts against; Latch refuses a run over a limit (HTTP 429 with a retry time), stops a long run when it uses up its token budget, and records usage when it finishes. Request limits hold even when many requests arrive at once. Token and cost limits are checked against usage already recorded, so runs that are still going can take them over by what those runs spend. Without it, nothing is limited. |
| `extensions` (optional) | `Extension[]` | Extensions that apply to every run, before each agent's own. An extension can react to points in a run (before a turn, after each step, on finish) to add context, store data or stop the run. |
| `maxInlineFileBytes` (optional) | `number` | The most bytes of files a user message may carry inline (as `data:` URLs, which is how `useChat` sends attachments by default). Inline files travel in the chat request and are stored in the message, then reloaded on every turn; a message over the limit is refused (`InvalidMessageError`, HTTP 400). Send larger files by URL. Default: `20 MB`. |

## durability

Crash recovery. Turn it on, then call `runtime.cron()` on a timer: that is what finds and resumes interrupted runs.

```ts
createRuntime({ …, durability: { enabled: true } });
```

| Option | Type | Description |
| --- | --- | --- |
| `enabled` (optional) | `boolean` | Turn crash recovery on. You also need to call `runtime.cron()` regularly (for example from a cron route every minute): that is what finds and resumes interrupted runs. Default: `false`. |
| `leaseTtlMs` (optional) | `number` | How long a server's claim on a run lasts without being renewed, in ms. When a server dies, its runs are picked up once this has passed, so a crashed run is resumed after roughly this long plus your cron interval. Default: `30_000`. |
| `heartbeatMs` (optional) | `number` | How often a server renews its claim while a run is going, in ms. Keep it well below `leaseTtlMs`, so a slow renewal never lets a live run expire. Default: `10_000`. |
| `instanceId` (optional) | `string` | A name for this server, recorded on the runs it claims. Set it to something stable (a pod or instance name) to see in the database which server owns which run. Default: `a random id per process`. |

## limits

Usage limits. `limitsFor` returns the limits a run counts against; each limit is a counter, a window and caps.

```ts
import { DAY_MS } from "@intentface/latch-core";
import { createPostgresLimitStore } from "@intentface/latch-drizzle";

createRuntime({
  …,
  limits: {
    store: createPostgresLimitStore(db),
    limitsFor: ({ principal }) => [
      { key: `org:${principal.orgId}`, windowMs: 30 * DAY_MS, max: { tokens: 5_000_000 }, label: "your organization's monthly budget" },
      { key: `user:${principal.orgId}:${principal.userId}`, windowMs: DAY_MS, max: { turns: 200 }, label: "your daily requests" },
    ],
  },
});
```

| Option | Type | Description |
| --- | --- | --- |
| `store` | `LimitStore` | Where the counters are kept: `createPostgresLimitStore` or `createSqliteLimitStore` from `@intentface/latch-drizzle`. |
| `limitsFor` | `(input: { principal: P; agent: string; trigger: TurnTrigger; }) => LimitPolicy[] \| Promise<LimitPolicy[]>` | Returns the limits this run counts against. Called before every run, so keep it fast; reading the customer's plan from a cache is fine. Return `[]` for no limits. A typical setup returns one limit per level: the organization's monthly tokens, the user's daily requests, and a tighter budget for an expensive agent. `trigger` lets background runs (schedules, webhooks) count against different limits from people chatting. |
| `onRefused` (optional) | `((input: { principal: P; agent: string; trigger: TurnTrigger; policy: LimitPolicy; usage: LimitUsage; retryAfterMs: number; }) => void \| Promise<void>)` | Called when a run is refused for being over a limit. For metrics and alerts; it must not throw. |

Each limit:

| Option | Type | Description |
| --- | --- | --- |
| `key` | `string` | The counter's name. Runs that return the same key share one counter, so name the level in it: `org:o1` for a whole organization, `user:o1:u1` for one person, `agent:o1:research` for one agent. |
| `windowMs` | `number` | How long one window lasts, in ms: `HOUR_MS`, `DAY_MS`, or your own. Windows are fixed, not rolling: a daily limit resets at midnight UTC. |
| `max` | `{ turns?: number; tokens?: number; cost?: number; }` | The caps within one window. Leave a cap out for no limit on it. |
| `label` (optional) | `string` | How the refusal names this limit to the user, for example `"your organization's daily token budget"`. |

> **Which caps hold under load**
>
> Request caps (`turns`) are counted before a run is allowed, so many requests arriving together can't all slip through. Token and cost caps are checked against usage already recorded: runs that are still going can take the total over by what they spend.
