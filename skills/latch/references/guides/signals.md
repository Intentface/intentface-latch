<!-- Generated from apps/docs/content/docs/guides/signals.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Tell a chat something from your server

Send a chat an answer that arrived from elsewhere, a finished job, or a message from someone else. The agent answers it at once, or reads it with the user's next message.

Online: https://intentface-latch-docs.vercel.app/docs/guides/signals

## Background

Some things a chat should know are typed by nobody in it. A question the agent couldn't answer went to a human expert, who replied hours later somewhere else. A background job finished. A colleague wrote into a chat that belongs to someone else.

`runtime.sendSignal` stores such a note in the chat and changes nothing already stored. By default the agent answers it straight away. With `wake: false` it only waits there, and the agent reads it with the user's next message.

## Send a notice

```ts
await runtime.sendSignal({
  chatId,
  principal, // whose chat it is
  text: "The tax expert answered the question about form 6B: file it by 31 March, with the 2024 annex.",
});
// → { id, turn? } | null (the chat doesn't exist, or isn't the principal's)
```

A notice is your application speaking. Only server code can add one: a message from a client is rebuilt as a plain user message, so nobody can type their way into one.

Call it at any time, also while an answer is running. That answer doesn't see the notice; the next turn does. Pass your own `id` when the call might be retried: the same id stores once, and starts a turn at most once.

## Send a person's message

```ts
await runtime.sendSignal({
  chatId,
  principal,
  kind: "message",
  from: { name: "Ann Lee", via: "expert console" },
  text: "Use the 2024 annex, not the 2023 one.",
  visibility: "user",
});
```

A `message` is a named person other than the chat's user. The model reads it as a person speaking, never as your application.

## The agent answers it

```ts
const sent = await runtime.sendSignal({
  chatId,
  principal,
  text: "The export the user asked for is ready: https://files.example.com/export-41.csv",
});
// sent.turn → { answer, parked, error? } when a turn ran; absent when the signal was only stored
```

The chat's own agent runs a turn with the signal as what it answers, as `principal`, and the call resolves when the answer is finished. The turn counts against the agent's limits like any other, and a tool that needs approval waits for the user.

A turn starts at once only when the chat is free. With an answer already running, or an approval or a tool result pending, the signal is held and gets its turn when that ends: the result is `{ id, queued: true }`, and the answer is in the history afterwards. See [Messages that arrive while the agent is answering](./queue.md).

Three cases fall back to waiting for the user's next message, with neither `queued` nor `turn` in the result: a limit was reached, the chat's queue is full (`inputQueue.max`, 20 by default), or the storage adapter has no input queue.

Nothing streams to an open page. The answer is in the chat's history the next time the page loads it. On a serverless host, keep the function alive until the call resolves (`waitUntil`).

## Only store it

Pass `wake: false` when the agent should know something but has nothing to say about it yet:

```ts
await runtime.sendSignal({
  chatId,
  principal,
  text: "The user's plan changed to Team.",
  wake: false,
});
```

No turn starts and no model is called. The agent reads the signal with the user's next message.

## Who sees it

| | Default | Change it with |
| --- | --- | --- |
| The agent | always: at once, or from the next turn with `wake: false` | — |
| The user | no | `visibility: "user"` |

A visible signal comes back from `loadHistory` as a message with `role: "system"` and `metadata.signal` (`{ kind, from }`). Render it from that yourself: chat UIs are built around `user` and `assistant` messages, so check what yours does with a `system` one.

A signal is not posted to a channel, and neither is the agent's answer to one. For a chat in Slack, Telegram and the others, pass `wake: false`: the agent knows the signal from the person's next message, and the person sees nothing until the agent says it.

## How the model reads it

| Model | A notice | A person's message |
| --- | --- | --- |
| Claude Fable, Mythos, Opus 4.8 and later, Sonnet 5.5, Haiku 5.5: from Anthropic, on Vertex, or on Bedrock through `@ai-sdk/amazon-bedrock/anthropic` | a system message after the user's next message | a `<message from="…">` block at the top of the user's next message |
| OpenAI models, from OpenAI or on Azure | a system message there (a developer message on reasoning models) | the same block |
| Everything else, including Gemini, older Claude models, and Claude through Bedrock's default `bedrock()` model | a `<notice>` block at the top of the user's next message | the same block |

The table is for a signal that waited. One that started a turn is read at its own place: as a system message after a short user message saying nobody wrote, or as the block on its own.

When a turn failed before answering and the user wrote again, the system message goes after the last of those user messages: Anthropic takes one only where the answer comes next.

A system message outranks what the user says. A `<notice>` block does not: a user can type one too. If your application depends on a notice being trusted, run the agent on a model in the first two rows.

Override the choice per model with `resolveNoticePlacement` on the runtime:

```ts
import { anthropicTakesSystemMidConversation, createRuntime } from "@intentface/latch-core";

createRuntime({
  // …
  // Claude behind a proxy Latch doesn't recognise as Anthropic.
  resolveNoticePlacement: (modelId) => (anthropicTakesSystemMidConversation(modelId) ? "system" : "user"),
});
```

Return `"system"` only for a model that takes system messages mid-conversation. On one that doesn't, the request fails, and it fails on every later turn too, since the notice stays in the chat's history.

## What goes in a signal

Text your application wrote, or a person it vouches for. Phrase a notice as something the agent should know ("the expert answered: …"), not as an order that overrides the user.

Documents, search results and tool output don't belong in a signal. A system message is trusted by the model, so anything a third party wrote there can steer it. Keep that content in tool results.

## What it doesn't do yet

- **Stream to an open page.** A visible signal, and the agent's answer to one, appear when the page next loads its history or [polls the chat](./queue.md#keep-the-page-current-without-a-stream).
