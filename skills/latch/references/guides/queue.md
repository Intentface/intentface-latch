<!-- Generated from apps/docs/content/docs/guides/queue.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Messages that arrive while the agent is answering

Hold a message or signal that arrives mid-answer and have the agent answer it next, and keep a page current by polling when it has no stream open.

Online: https://intentface-latch-docs.vercel.app/docs/guides/queue

## Background

A chat runs one answer at a time. By default a message sent while one is running is refused with `chat_busy` (409), and the client sends it again later.

With the input queue, that message is held instead. When the running answer ends, the agent starts the next turn with everything that is waiting: the user's follow-ups, and any [signals](./signals.md) your server sent in the meantime.

The queue needs a storage adapter that has it. The shipped Drizzle adapters do, after `migrate`. An adapter without it keeps the default behaviour.

## Hold a message

Send `queue: true` with the message:

```ts
const res = await fetch(`/api/latch/agents/${agent}/${chatId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message, queue: true }),
});

if (res.status === 202) {
  const { queued } = await res.json(); // { id }: held, no stream
} else if (res.ok) {
  // the chat was free: res is the answer's stream, as always
} else {
  const { code } = await res.json(); // refused, nothing was stored: `queue_full` (429), `limit_exceeded` (429), …
}
```

From server code it is `runtime.handleChat({ …, ifBusy: "queue" })`.

A held message is not in the chat's history yet. It joins the history when its turn starts, so the history always reads in the order things happened. From that moment it no longer counts as waiting: it is not in `queued`, it can't be taken back, and its place in the queue is free.

Two kinds of message are never held: one that regenerates or edits the question being answered, and anything past the cap.

## What the agent does with what is waiting

- **One turn for everything.** If two messages and a notice are waiting, the agent reads all three and writes one answer.
- **In order.** User messages keep the order they arrived in. Signals are read with them, the way a signal is read with the user's next message.
- **Again, if more arrived.** Whatever came in during that turn gets the turn after it.
- **Not while the chat waits on a person.** If the answer ended on an approval or a question for the user, what is waiting stays waiting until that is decided.

A signal sent to a busy chat is held the same way. `sendSignal` then returns `{ id, queued: true }` with no `turn`. With `wake: false` a signal is never held: it is stored and read with the user's next message.

## The cap

A chat holds at most 20 waiting inputs. Past that, a message is refused with `queue_full` (429), and a signal is stored to be read with the user's next message. Change it on the runtime:

```ts
createRuntime({
  // …
  inputQueue: { max: 50 },
});
```

## Show and cancel what is waiting

```ts
const waiting = await runtime.listQueued({ chatId, principal });
// the waiting messages the user may see, oldest first

await runtime.cancelQueued({ chatId, principal, id });
// → true, or false when its turn already started
```

Over HTTP: the poll below returns `queued`, and `DELETE chats/:chatId/queue/:messageId` takes one back. A user can only cancel what they can see waiting, so not a signal you sent without `visibility: "user"`.

## Keep the page current without a stream

A held message is answered after the stream that was open has ended, and a signal's answer is written by whatever server code sent it. Neither reaches an open page on its own. The page asks (or, with [live updates](./live-updates.md), is told):

```ts
const poll = await runtime.pollChat({ chatId, principal, cursor });
// → { cursor, running, queued, messages? } | null
```

- `messages` is the history as `loadHistory` returns it. It is left out when nothing changed since `cursor`.
- `running` says an answer is being written. It is saved after each step, so polling shows it grow step by step, not token by token.
- `queued` is what `listQueued` returns.

Over HTTP it is `GET chats/:chatId/poll?cursor=…`. With `useChat`:

```tsx
const { messages, setMessages, sendMessage, status } = useChat({ id: chatId, transport });
const [chat, setChat] = useState({ running: false, queued: [] });
const cursor = useRef<string>();

useEffect(() => {
  // The page's own stream is the truth while it is open.
  if (status !== "ready") return;
  let stopped = false; // a stream opened, or the chat changed, since this effect ran
  let busy = false; // one poll at a time: a slow one must not land after a newer one
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const q = cursor.current ? `?cursor=${cursor.current}` : "";
      const res = await fetch(`/api/latch/chats/${chatId}/poll${q}`);
      if (stopped || !res.ok) return;
      const poll = await res.json();
      if (stopped) return;
      cursor.current = poll.cursor;
      setChat({ running: poll.running, queued: poll.queued });
      if (poll.messages) setMessages(poll.messages);
    } finally {
      busy = false;
    }
  };
  void tick(); // straight away when a stream ends: a held message may have been answered
  const timer = setInterval(tick, 3000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}, [chatId, status]);
```

`sendMessage` expects a stream back, so use it only when the chat is free. While `status` is not `ready`, or `chat.running` is true, send with the `fetch` call above and render `chat.queued` below the conversation.

## Who runs the next turn

The process that wrote the answer that just ended. Two things follow from that.

**Give the runtime `waitUntil`.** The next turn has to outlive the response that was open:

```ts
import { waitUntil } from "@vercel/functions"; // or your host's equivalent

createRuntime({
  // …
  waitUntil, // on a long-running server: (work) => void work
});
```

With it, the page's stream closes when its own answer is done and the page is ready again. The next answer is never on that stream: the page gets it by polling, which shows it as it is written. A held message's `202` comes back at once.

Without it, Latch keeps the open stream open, with nothing more on it, until the next turn is finished. That works on every host, since an open response is what keeps a function alive, but the page shows "answering" for both turns, and it still has to poll (or reload the history) after the stream closes to get the second answer.

**Call `runtime.cron()`.** If that process dies before it starts the next turn, the cron tick does: it picks up inputs that have waited more than 15 seconds with nobody starting a turn for them. Its result counts them as `held`. A chat that is busy, or waiting on a person, is left alone.

## What it doesn't do yet

- **Stream the next turn to the page.** The answer to a held message arrives by polling, step by step, unless you set up [live updates](./live-updates.md) (experimental).
- **Expire.** A held input waits as long as it takes, for example behind an approval nobody answers.
- **Poll cheaply on long chats.** Each poll reads the whole history on the server to tell whether it changed; only the response is small.
