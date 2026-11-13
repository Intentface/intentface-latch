<!-- Generated from apps/docs/content/docs/guides/live-updates.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Live updates on every open page

Show an answer as it is written on a page that didn't ask for it — a second tab, a reloaded page, the answer to a signal or a held message — with Redis on serverless hosts.

Online: https://intentface-latch-docs.vercel.app/docs/guides/live-updates

> **Experimental**
>
> New in this release. The names and the events may change.

## Background

An answer streams to the request that asked for it. Every other page sees it once it is saved: a second tab, a page reloaded mid-answer, and any page when the answer was started by a [signal](./signals.md), a [held message](./queue.md) or a schedule. Those pages [poll](./queue.md#keep-the-page-current-without-a-stream).

With `liveStreams` on the runtime, they get the answer as it is written:

- the runtime keeps each running answer's stream where another request can read it, and
- a page holds one connection per chat that tells it when an answer starts.

It is optional. Without it nothing changes, and polling still works with it.

## Where the stream is kept

A request that reads the stream has to reach whatever is writing it.

**One long-running server.** Memory is enough:

```ts
import { createRuntime, memoryLiveStreams } from "@intentface/latch-core";

createRuntime({
  // …
  liveStreams: memoryLiveStreams(),
});
```

**Serverless, or more than one server.** The reader lands on another instance than the writer, so the stream goes through something both reach. Redis pub/sub does it, with the [`resumable-stream`](https://github.com/vercel/resumable-stream) package for the answer and two plain commands for the events. Any Redis-compatible server works (Valkey, Upstash).

```ts title="lib/live-streams.ts"
import { createClient } from "redis";
import { createResumableStreamContext } from "resumable-stream";
import { waitUntil } from "@vercel/functions"; // null on a long-running server
import type { LiveStreams } from "@intentface/latch-core";

// Pub/sub needs a connection of its own.
const publisher = createClient({ url: process.env.REDIS_URL });
const subscriber = publisher.duplicate();
const connected = Promise.all([publisher.connect(), subscriber.connect()]);

const streams = createResumableStreamContext({ waitUntil, publisher, subscriber });

export const liveStreams: LiveStreams = {
  // The running answer, readable from its start.
  publish: async (id, stream) => {
    await connected;
    await streams.createNewResumableStream(id, () => stream);
  },
  subscribe: async (id) => {
    await connected;
    return (await streams.resumeExistingStream(id)) ?? null;
  },
  // "Something happened in this chat", to whoever is listening now.
  notify: async (channel, message) => {
    await connected;
    await publisher.publish(`latch:${channel}`, message);
  },
  listen: async (channel) => {
    await connected;
    let listener: ((message: string) => void) | undefined;
    return new ReadableStream<string>({
      async start(controller) {
        listener = (message) => controller.enqueue(message);
        await subscriber.subscribe(`latch:${channel}`, listener);
      },
      async cancel() {
        if (listener) await subscriber.unsubscribe(`latch:${channel}`, listener);
      },
    });
  },
};
```

Then `createRuntime({ …, liveStreams })`.

`notify` and `listen` are optional. A store with only `publish` and `subscribe` gives a page the stream of a running answer, and the page learns that one is running by polling.

## The two routes

[The handler](./mount-the-handler.md) serves both. In your own routes, return what the runtime returns:

```ts
// GET chats/:id/events — one long-lived connection per open chat
return (await runtime.watchChat({ chatId, principal })) ?? new Response(null, { status: 404 });

// GET chats/:id/stream — the running answer, from its start
return (await runtime.streamChat({ chatId, principal })) ?? new Response(null, { status: 204 });
```

`watchChat` sends server-sent events:

| Event | Means | The page |
|---|---|---|
| `{ "type": "hello", "running": boolean }` | First on every connection: whether an answer is running now. | loads the history; reads the stream if one is running |
| `{ "type": "started" }` | An answer started. | loads the history, then reads the stream |
| `{ "type": "ended" }` | That answer ended and is saved. | loads the history |
| `{ "type": "changed" }` | Something else changed: a signal was stored, a message was held or taken back. | loads the history |

`streamChat` returns the answer as `useChat` reads it when it resumes: everything written so far, then the rest as it comes. It answers `null` (204) when nothing is running.

## On the page

Tell the transport where the running answer is read, and act on the events:

```tsx
const transport = new DefaultChatTransport({
  api: `/api/latch/agents/${agent}/${chatId}`,
  prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
  prepareReconnectToStreamRequest: () => ({ api: `/api/latch/chats/${chatId}/stream` }),
});

const { messages, setMessages, resumeStream, status } = useChat({ id: chatId, transport });
const [queued, setQueued] = useState([]);
const statusRef = useRef(status);
statusRef.current = status;

useEffect(() => {
  const events = new EventSource(`/api/latch/chats/${chatId}/events`);
  let work = Promise.resolve(); // one event at a time, in order
  events.onmessage = (e) => {
    const event = JSON.parse(e.data);
    const answering = event.type === "started" || (event.type === "hello" && event.running);
    work = work.then(async () => {
      const res = await fetch(`/api/latch/chats/${chatId}/poll`);
      if (!res.ok) return;
      const poll = await res.json();
      setQueued(poll.queued);
      // This page sent the message: it is reading the answer already.
      if (statusRef.current !== "ready") return;
      // The history first: the message that started the answer may have
      // been sent from somewhere else.
      setMessages(poll.messages);
      if (answering) await resumeStream();
    });
  };
  return () => events.close();
}, [chatId]);
```

That covers a second tab, a page reloaded mid-answer (`hello` says one is running), and answers to signals and held messages. The poll loop from [the queue guide](./queue.md#keep-the-page-current-without-a-stream) is no longer needed; keep it as the fallback when `events` answers 404, which is what a runtime without `notify` and `listen` does.

## On serverless

- **The events connection is cut at the function's maximum duration.** `EventSource` connects again on its own, and `hello` tells it where the chat stands.
- **Each open chat holds one function invocation open** for as long as the page is. Count that against your plan's concurrency before turning it on for every visitor.
- **`waitUntil`.** Pass your host's to `createResumableStreamContext`, as above, so the instance writing an answer stays alive to serve readers.

## What it doesn't do yet

- **Replay missed events.** An event sent while a page is reconnecting is not sent again. `hello` covers an answer that is running; for anything else the page loads the history when it connects.
- **Survive the writer.** If the instance writing an answer dies, its stream ends. With [crash recovery](./crash-recovery.md) another instance finishes the answer and pages are told when it `started` again.
- **Carry the answer on the events connection.** The page opens a second request for each answer.
