<!-- Generated from apps/docs/content/docs/reference/runtime.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Runtime methods

What each method of the runtime does, with every input and result.

Online: https://intentface-latch-docs.vercel.app/docs/reference/runtime

`createRuntime` returns the runtime. Your server calls it from its routes: one call per chat message, approval decision or cron tick. Every method that takes a `principal` only ever sees that principal's data.

| Option | Type | Description |
| --- | --- | --- |
| `listAgents` | `(principal: P) => Promise<AgentInfo[]>` | The agents this person can use (yours and their dynamic ones), for an agent picker. |
| `handleChat` | `(input: HandleChatInput<P>) => Promise<Response>` | Runs one chat turn and streams the answer. Returns a streaming `Response` in the AI SDK's UI message format, ready to return from your route to `useChat`. The run keeps going and is saved even if the client disconnects. |
| `runAgent` | `(input: RunAgentInput<P>) => Promise<RunAgentResult>` | Runs an agent to completion without a client and returns its answer: for webhooks, background jobs, tests and evaluations. Never throws for a run that fails once started; the failure comes back as `error`. |
| `compactChat` | `(input: { chatId: string; principal: P; focus?: string; request?: Request; turnContext?: unknown; }) => Promise<{ summary: string; compacted: number; } \| null>` | Summarizes a long conversation so later turns send the model the summary instead of the old messages. The stored history is kept in full. Returns `null` when there is too little to summarize or the chat isn't the caller's; throws `PendingApprovalError` while the chat waits on an approval. |
| `loadHistory` | `(input: { chatId: string; principal: P; }) => Promise<AppMessage[]>` | A chat's messages for showing to the user, with internal messages left out. Use it to render a conversation when the page loads. |
| `listChats` | `(input: { principal: P; limit?: number; kind?: string; }) => Promise<ChatRecord[]>` | The caller's chats, newest first, for a sidebar. Pass `kind: "user"` to leave out the threads subagents use internally. |
| `getChat` | `(input: { principal: P; id: string; }) => Promise<ChatRecord \| null>` | One chat, or `null` when it doesn't exist or isn't the caller's. |
| `listRuns` | `(input: { principal: P; limit?: number; }) => Promise<RunRecord[]>` | The caller's runs, newest first, with status, usage and cost: for an activity or usage view. |
| `getRun` | `(input: { principal: P; runId: string; }) => Promise<RunRecord \| null>` | One run, or `null` when it doesn't exist or its chat isn't the caller's. |
| `deleteChat` | `(input: { principal: P; chatId: string; }) => Promise<{ deleted: string[]; }>` | Deletes one of the caller's chats with its messages, runs and usage, and the subagent threads it spawned. Returns the ids deleted: empty when the chat isn't the caller's. Refuses a chat with an answer still running (`ChatBusyError`), and `UnsupportedOperationError` when the storage adapter can't delete. |
| `purgeOwner` | `(segments: string[], opts?: PurgeOptions & { also?: Record<string, OwnerPurgeable>; }) => Promise<{ removed: Record<string, Record<string, number>>; }>` | Deletes everything stored for an owner path, in every store you pass: `["t1"]` removes a whole tenant (keys `t1` and `t1/…`), `["t1", "u7"]` one person. Runs each store's purge until it's done and returns what each removed. Checks first that every store can purge, and refuses (`UnsupportedOperationError`) before deleting anything if one can't. Chats, messages, runs and schedules are covered by the storage adapter. The usage ledger is kept and re-filed one level up by default, since billing records usually must outlive the person (see `PurgeOptions`): pass `usage: "delete"` to remove a whole tenant. Pass your other stores by name in `also`: the secret store, stored agents, the memory job store, your own channel store. The result reports each under the same name (the storage adapter as `storage`). Usage-limit counters are keyed by names you chose, and may contain the person's id (`user:org1:u7`): clear those yourself for a complete erasure. |
| `resume` | `(run: string \| Pick<RunRecord, "id" \| "ownerKey">) => Promise<RunOutcome \| null>` | Resumes one interrupted run and finishes it. Needs `durability`. Returns `null` when the run can't be resumed: it already finished, or another server has it. You rarely call this yourself; `cron()` does it. Pass the run record (from `reapExpiredRuns`, say) rather than its id when your storage adapter checks or routes by owner key: the record carries it. |
| `sweep` | `(opts?: { now?: number; maxAttempts?: number; error?: string; }) => Promise<{ reaped: RunRecord[]; resumed: RunOutcome[]; errors: string[]; }>` | Finds runs whose server died and resumes them. Gives up on a run after `maxAttempts` tries (default 5), so one that crashes every time can't loop forever. Safe to call from every server at once. Needs `durability`; `cron()` calls it for you. |
| `cron` | `(opts?: { now?: number; maxAttempts?: number; }) => Promise<{ due: RunDueResult; reaped: RunRecord[]; resumed: RunOutcome[]; errors: string[]; }>` | The one function to call on a timer: fires due schedules, then (with `durability`) resumes interrupted runs. Call it every minute or so from a cron route, or with `createIntervalScheduler`. Safe to call from every server at once. Failures are returned in `errors`, never thrown. |
| `applyApproval` | `(input: ApplyApprovalInput<P>) => Promise<Response>` | Records a person's approve or deny decisions and continues the run: approved tools run, denied ones don't. Returns the continuation as a streaming `Response`. Works from any device or channel, any time later, because the waiting state is stored in the conversation. Repeated or stale decisions are ignored. |
| `applyToolResult` | `(input: ApplyToolResultInput<P>) => Promise<Response>` | Answers a tool the client handles (one without `execute`, like `askUser`) and continues the run. Returns the continuation as a streaming `Response`, or an empty response while other client tools in the same step still need answers. |
| `schedule` | `(input: ScheduleInput<P>) => Promise<ScheduleRecord>` | Schedules an agent to run on a timer, as the caller. |
| `listSchedules` | `(input: { principal: P; }) => Promise<ScheduleRecord[]>` | The caller's schedules. |
| `unschedule` | `(input: { principal: P; id: string; }) => Promise<void>` | Deletes one of the caller's schedules. |
| `runScheduleNow` | `(input: { principal: P; id: string; }) => Promise<boolean>` | Makes one of the caller's schedules fire on the next cron tick, exactly as a timed fire would. Returns `false` when there was nothing to run: the id is unknown, not the caller's, or a one-off that already ran. |
| `runDue` | `(opts?: { now?: number; }) => Promise<RunDueResult>` | Fires every schedule that is due, for all customers. `cron()` calls it; call it directly only if you drive schedules separately from crash recovery. Waits for each fired run to finish. |

## handleChat

Runs one chat turn and streams the answer back. Return its `Response` straight from your route to `useChat`.

```ts
export async function POST(req: Request) {
  const principal = await requireUser(req);
  const { id, message, agent } = await req.json();
  return runtime.handleChat({ agent, chatId: id, principal, message, request: req });
}
```

| Option | Type | Description |
| --- | --- | --- |
| `agent` (optional) | `string` | The agent to run, by name (a key of `agents`, or a dynamic agent's name). Required for a new chat; a continuing chat uses the agent it was started with when omitted. |
| `chatId` (optional) | `string` | The chat to continue. Pass the same id on every message of a conversation; a new id starts a new chat with that id. Omit it to start a new chat with a generated id. |
| `principal` | `P` | Who is asking, as your auth resolved it. Everything the run reads and writes is scoped to this principal, so build it on the server, never from client input. |
| `message` | `AppMessage` | The user's message, as `useChat` sends it. Accepted: - a new user message with text and files (files sent inline count against `maxInlineFileBytes`); - the chat's last question resent unchanged (`regenerate()`) or edited (`sendMessage({ messageId })`): the old answer is hidden, not deleted, and the agent answers again; - the paused assistant message with approval answers on it (`addToolApprovalResponse` with `sendAutomaticallyWhen`): only the decisions are read, as `applyApproval` would. Anything else is refused: another role or part type (`InvalidMessageError`, 400), or an earlier question regenerated or edited (`RewindNotSupportedError`, 409; fork the chat instead). |
| `params` (optional) | `unknown` | What the chat is about, for an agent that declares `params` (see `defineAgent`). Pass them with the chat's first message; they're validated, saved on the chat, and given to the agent on every later turn, so later messages don't send them again. Sending the same params again is fine; different ones are refused (`ParamsFixedError`, 409). |
| `request` (optional) | `Request` |  |
| `turnContext` (optional) | `unknown` |  |

## runAgent

Runs an agent to completion with no client attached: a webhook, a background job, a test. Returns the final answer.

```ts
const { answer, error } = await runtime.runAgent({
  principal,
  agent: "triage",
  prompt: `New ticket: ${ticket.title}`,
  trigger: "programmatic",
});
```

| Option | Type | Description |
| --- | --- | --- |
| `principal` | `P` | Who the run acts for. The run is scoped to this principal like a chat turn. |
| `agent` | `string` | The agent to run, by name. |
| `prompt` | `string` | The task, as the user message. |
| `files` (optional) | `{ url: string; mediaType: string; filename?: string; }[]` | Files sent with the prompt: `url` is a data URL or a URL the model provider can fetch. They come before the text in the user message. |
| `threadId` (optional) | `string` | Continue an earlier `runAgent` thread instead of starting a new one. |
| `params` (optional) | `unknown` | What the run is about, for an agent that declares `params`: validated and saved on the thread, so a resumed run gets them too. Continuing an existing `threadId` with different params is refused. |
| `blockGated` (optional) | `"simulate-success" \| boolean` | What happens to tools that need a person's approval, since nobody is there to give it: - `true`: they don't run; the model is told they were blocked. - `"simulate-success"`: they don't run; the model is told they succeeded. For testing what an agent would do next. - `false`: they run for real, without approval. Default: `true`. |
| `memory` (optional) | `boolean` | Set `false` to run without the agent's long-term memory: nothing is recalled and nothing saved. Useful when running one agent over many test inputs, so earlier inputs can't influence later ones. |
| `model` (optional) | `LanguageModel` | Run on a different model than the agent's own, for this run only. For comparing models on the same task. |
| `turnContext` (optional) | `unknown` |  |
| `promptCaching` (optional) | `boolean` | Set `false` to turn prompt caching off for this run, for example as the control in a cost comparison. |
| `trigger` (optional) | `TurnTrigger` | How telemetry labels this run. Pass `"chat"` when a person is waiting on the answer, for example a webhook that replies to them. Default: `"programmatic"`. |

It returns:

| Option | Type | Description |
| --- | --- | --- |
| `threadId` | `string` | The thread the run used. Pass it back as `threadId` to continue. |
| `answer` | `string` | The agent's final answer. Empty when the run failed. |
| `error` (optional) | `string` | Why the run failed, when it did: the model provider refused, a tool source wouldn't open, and so on. |

## applyApproval

Continues a run that paused on a tool needing approval. Decisions that are no longer pending (a double click, an old tab) are ignored, so it is safe to call more than once.

```ts
return runtime.applyApproval({
  chatId,
  principal,
  decisions: [{ approvalId, approved: true }],
});
```

| Option | Type | Description |
| --- | --- | --- |
| `chatId` | `string` | The chat whose run is waiting. |
| `principal` | `P` | Who is deciding. Must be allowed to see the chat. |
| `decisions` | `ApprovalDecision[]` | One decision per approval request. A decision for a request that is no longer waiting (already decided, or from an older message) is ignored. |
| `request` (optional) | `Request` |  |
| `turnContext` (optional) | `unknown` |  |

Each decision:

| Option | Type | Description |
| --- | --- | --- |
| `approvalId` | `string` | The approval request's id, from the tool part's `approval.id`. |
| `approved` | `boolean` | `true` lets the tool run; `false` stops it. |
| `reason` (optional) | `string` | Why, shown to the model, for example why a request was denied. |

## applyToolResult

Continues a run that paused on a tool the client answers, such as `askUser`.

| Option | Type | Description |
| --- | --- | --- |
| `chatId` | `string` | The chat whose run is waiting. |
| `principal` | `P` | Who is answering. Must be allowed to see the chat. |
| `toolCallId` | `string` | The tool call being answered, from the message part. |
| `output` | `unknown` | The tool's result, for example the user's answer to `askUser`. |
| `request` (optional) | `Request` |  |
| `turnContext` (optional) | `unknown` |  |

## schedule

Runs an agent on a timer, as the caller. Recurring schedules need `cron` in the runtime config, and a timer calling `runtime.cron()`.

```ts
await runtime.schedule({
  principal,
  agent: "brief",
  cron: "0 9 * * 1",
  timezone: "Europe/Helsinki",
  prompt: "Summarise last week's tickets.",
});
```

| Option | Type | Description |
| --- | --- | --- |
| `principal` | `P` | Who the schedule runs as. Every fire acts for this principal, re-checked with `reconstructPrincipal` when one is configured. |
| `agent` | `string` | The agent to run, by name. |
| `cron` | `string \| null` | When to run, as a cron expression (`"0 9 * * 1"` is Mondays at 9:00). `null` runs it once, on the next cron tick. Recurring schedules need `cron` in the runtime config. |
| `timezone` (optional) | `string` | The time zone the cron expression is read in, for example `"Europe/Helsinki"`. Default: `"UTC"`. |
| `prompt` | `string` | The message the agent receives on every fire. |
| `delivery` (optional) | `unknown` | Where the result should go, for your `runSchedule` hook to read (a Slack channel, a Telegram chat). Saved as it is; Latch never reads it. |
| `onParked` (optional) | `"fire" \| "skip"` | What to do when it's time to fire but the previous fire is still waiting on a person (an approval nobody has given): - `"skip"`: skip this fire, so unanswered runs don't pile up. - `"fire"`: run anyway. For schedules where every fire matters, like a daily digest. Default: `"skip"`. |
| `params` (optional) | `unknown` | Params for the agent (see `defineAgent`): checked now, saved with the schedule, and given to the chat each fire starts. |

## cron

The one function to call on a timer, every minute or so. It fires due schedules and, with `durability` on, resumes interrupted runs. Safe to call from every server at once.

```ts
// app/api/cron/route.ts — called by your platform's cron every minute
export async function GET() {
  const { due, resumed, errors } = await runtime.cron();
  return Response.json({ fired: due.fired, resumed: resumed.length, errors });
}
```

What `due` reports:

| Option | Type | Description |
| --- | --- | --- |
| `fired` | `number` | Fires that ran. |
| `errors` | `number` | Fires that failed. |
| `skipped` | `number` | Fires skipped because the previous one is still waiting on a person (`onParked: "skip"`). |
| `parked` | `number` | Fires that ran and then stopped, waiting on an approval or a question nobody is there to answer. Tokens were spent and no answer was delivered, so a non-zero number is worth looking at. |
| `rejected` | `number` | Fires refused because `reconstructPrincipal` returned `null` (the person no longer has access). Their schedules are disabled. |
