<!-- Generated from apps/docs/content/docs/guides/chat-ui.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# The chat UI

What a browser client owes the handler — streaming, markdown, approval cards, and the OAuth continuation protocol.

Online: https://intentface-latch-docs.vercel.app/docs/guides/chat-ui

Latch ships no browser package (yet). The handler speaks the AI SDK's UIMessage
SSE protocol, so any AI SDK-compatible chat client works for the happy path —
but four things are **your client's job**, and every one of them looks like a
Latch bug when it's missing. This page exists so you don't discover them in
production.

## Rendering: assistant output is markdown

Models emit markdown. If your message component renders assistant text as a
plain string, every table arrives as literal pipes and every heading as `##` —
and nothing errors. User input and assistant output need **different**
treatment: render the user's text verbatim, and run the assistant's through a
markdown renderer.

If you build on `@intentface/chat`, note that `Message.Text` takes a plain
string by design (chip segmentation operates on it) — assistant turns need a
sibling markdown renderer, as its reference example shows.

## Approvals: a paused turn is message state

A gated tool call ends the stream with the assistant message carrying a part in
`state: "approval-requested"`. Nothing else will happen until someone decides.

The simplest client uses the AI SDK's own approval flow. `useChat` marks the
card answered and sends the message back once every card in the step has an
answer; Latch reads only the decisions from it (never the inputs or anything
else in the client's copy) and streams the continuation into the same message:

```tsx
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";

const { messages, sendMessage, addToolApprovalResponse } = useChat({
  id: chatId,
  transport: new DefaultChatTransport({
    api: `/agents/${agent}/${chatId}`,
    // Latch keeps the history: send only the newest message.
    prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
  }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});

// On each card:
<button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>Approve</button>
```

Decisions that come from elsewhere (a Slack button, another device, a card
rendered outside `useChat`) go to `POST /agents/:agent/:id/approvals` instead. When the decision resumes the turn, the
response is a **continuation stream** of the same turn. When the same step has
*other* gated calls still undecided, the turn cannot resume yet — the response
is an **empty 200**, and the remaining cards stay live for their own
decisions. Check the response's `Content-Type` for `text/event-stream` before
feeding it to your stream reader; an empty body parsed as SSE fails
confusingly.

Denying is a real answer, not a cancel: the turn resumes and the agent says
what it will do instead. A user typing a new message instead of deciding also
resolves the gate (declined as superseded) — so stop rendering the card as
live once the user sends something.

## The continuation protocol

Whenever a paused turn resumes — an approval decision, a client-handled tool
result, or the OAuth flow below — the continuation stream has two properties
that are easy to miss and produce confusing UIs when missed:

1. **It reuses the last assistant message's id and streams only the new
   parts.** Seed your stream reader with a clone of that message before
   feeding it the continuation, or the answer renders as a second, half-empty
   message.
2. **Mirror the decision locally first.** The decision is saved before the
   continuation starts, but the stream won't show the card's new state until
   the tool's result arrives — mirror it in local state at click time, or the
   card sits on screen for the whole run. Reconcile against server history
   (`GET /chats/:id`) when the stream ends.

## Stop: a request, not a disconnect

`useChat`'s `stop()` aborts the browser's request. To the server that's the
same as closing the tab, and the answer keeps running so it's there when the
user comes back. A stop button sends its own request instead:

```ts
const onStop = () => fetch(`/api/latch/chats/${chatId}/stop`, { method: "POST" });
```

Don't call `chat.stop()` as well: the server ends the stream with an `abort`
part, so the open tab sees the answer end and `status` goes back to `ready`.
The saved message has `metadata.stopped: true`, for a "Stopped" label. A
`404` means nothing was running: the answer finished, or hadn't started yet.

## OAuth: the callback redirects — resuming is yours

When an agent needs a connection the user hasn't authorized, it calls the
synthetic `connect_<name>` tool, which parks the turn like any approval. The
user authorizes at `GET /connections/:name/authorize`; the IdP redirects back
to the callback, which finishes the token exchange and **redirects to
`returnTo` immediately** — it does not resume the turn (a browser must not
hang on a blank page for a whole run).

On arrival back at your chat page:

1. Strip the `?connected=<name>` param.
2. Find the pending `connect_<name>` approval part in the chat's history.
3. Submit it approved to `POST /agents/:agent/:id/approvals`.
4. Feed the returned continuation into your stream reader — seeded as above.

A `?error=` param instead (`flow_expired`, `missing_code`, an exchange
failure) means the flow didn't finish: leave the gate rendered so the user can
retry Connect, or deny it to let the agent route around the connection.
