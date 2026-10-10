<!-- Generated from apps/docs/content/docs/guides/approvals.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Gate a tool behind approval

Pause a run at a risky tool call, decide from any device or after a deploy, and resume — with no connection held open while waiting.

Online: https://intentface-latch-docs.vercel.app/docs/guides/approvals

## Background

An agent that can act needs a way to *not* act until a human agrees. In the AI SDK a tool marked `needsApproval` pauses the loop, but the pending approval lives in the process that is waiting — a websocket, a held request, a function that must not time out. Latch stores the pending approval as a part of the conversation instead. Nothing is held open; the decision can arrive tomorrow, from another device, after a deploy, and the run resumes from history.

This recipe gates one tool, decides it both ways, and shows the pause surviving a restart.

## Mark the tool

```ts
import { defineAgent } from "@intentface/latch-core";
import { tool } from "ai";
import { z } from "zod";

const support = defineAgent<Principal>({
  model,
  instructions: "You help with refunds. Confirm the amount before refunding.",
  tools: {
    refund: tool({
      description: "Refund a customer.",
      inputSchema: z.object({ customerId: z.string(), amountCents: z.number().int().positive() }),
      execute: async (input) => payments.refund(input),
    }),
  },
  toolApproval: { refund: "user-approval" },
});
```

Ask it to refund someone. The stream ends with an assistant message whose last part is in `state: "approval-requested"`, carrying `approval.id`. The tool has **not** run; the run's status is `awaiting_input`.

## Render the card and decide

Your client renders that part as an approve/deny card and posts the decision:

```ts
// POST /agents/support/:chatId/approvals   — or runtime.applyApproval(...)
{ "decisions": [{ "approvalId": "<approval.id>", "approved": true }] }
```

The response is a **continuation stream** of the same turn: it reuses the assistant message's id and streams only the new parts, so seed your reader with a clone of that message first ([The chat UI](./chat-ui.md#the-continuation-protocol)). The tool executes now and the agent finishes its answer.

## Deny it

Send `approved: false`. The tool never runs; the model is told and says what it will do instead. A denial is an answer, not a cancel — the conversation keeps going.

## Restart between the pause and the decision

Stop the server after the first request. Start it again. Post the decision. It works, because the pending approval is a row, not a waiting process. This is the whole reason for the design.

## Let the user walk away from it

If they type a new message instead of deciding, that message *is* the decision: the gate closes as declined and the new message proceeds. Stop rendering the card as live once they send something.

## Full example

```ts
import { createRuntime, defineAgent } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { tool } from "ai";
import { z } from "zod";

interface Principal { orgId: string; userId?: string }

const client = createClient({ url: "file:./latch.db" });
await migrate(client);
const storage = createSqliteAdapter<Principal>(drizzle(client, { schema }), {
  owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]),
});

const runtime = createRuntime<Principal, { orgId: string }>({
  storage,
  context: ({ principal }) => ({ orgId: principal.orgId }),
  agents: {
    support: defineAgent({
      model,
      instructions: "You help with refunds. Confirm the amount before refunding.",
      tools: {
        refund: tool({
          description: "Refund a customer.",
          inputSchema: z.object({ customerId: z.string(), amountCents: z.number().int().positive() }),
          execute: async (input) => payments.refund(input),
        }),
      },
      toolApproval: { refund: "user-approval" },
    }),
  },
});

// Turn 1: the model proposes `refund`; the stream ends awaiting a decision.
const first = await runtime.handleChat({ agent: "support", chatId: "c1", principal, message: userMessage });
// … render the approval-requested part …

// Turn 2 (any time later, any process): decide. The tool runs, the turn continues.
const continuation = await runtime.applyApproval({
  chatId: "c1",
  principal,
  decisions: [{ approvalId, approved: true }],
});
```

## Pitfalls already handled

- **The card is stale** (answered in another tab, or the turn moved on) — a tapped approval is checked against fresh history and a card for a vanished approval is retired, never pushed through.
- **Two gated calls in one step** — the first decision returns an empty `200`; the other card stays live for its own decision.
- **Who may click** — in a shared Slack thread only the person whose turn raised the gate, because the tool runs with their credentials; buttons are signed and bound to that actor.
- **A gate three subagents deep** — bubbles up to the human at the top as a part on the parent's message, and the decision routes back down.
- **The subagent stops at a second gate after you approve the first** — the decision's response streams the new card into the same message, alongside the subagent's progress while it resumes.
- **The parent tries to delegate again while it waits** — its turn stops at the paused delegation, so one decision means one card.
- **Nobody is there** — a scheduled run reaching a gate parks: `status: "awaiting_input"`, `trigger: "schedule"`. `runAgent` defaults to `blockGated: true`, stubbing gated tools so an unattended test has no side effects.
- **Which tools need a gate** — MCP tools marked destructive or non-read-only arrive gated from their own annotations.
- **OAuth connects** — a `connect_<name>` call is an approval whose resolution is a redirect, with the principal pinned when the flow starts.
- **Two clicks on one card** — the second meets the one-active-run-per-chat rule and is told the chat is busy.

## Run it

```bash
pnpm --filter @intentface/latch-example smoke:approval            # gate → await → approve runs / deny blocks
pnpm --filter @intentface/latch-example smoke:subagent-approval   # a sub gate bubbles to the parent
pnpm --filter @intentface/latch-example smoke:oauth               # connect_<name> through the OAuth flow
```

Mock model, no API key; sources in `apps/example/src`.

## Tools the browser answers

A tool with no `execute` (an `askUser`-style questionnaire) pauses the same way and resumes with `applyToolResult`:

```ts
await runtime.applyToolResult({ chatId, principal, toolCallId, output });
```

If other client tool calls in the same step still need results, this returns an empty `200` and waits for them.

## Approvals inside subagents

A gated tool *inside* a subagent suspends the parent turn and surfaces to the same human — it does not auto-approve out of sight. It arrives as a `data-subagent-approval` part on the parent's message, the parent's tool loop stops there as it would at a gate of its own, and the decision goes through the same `applyApproval`.

That decision resumes the subagent first, and its response streams what the resume does, continuing the paused message: the delegation's live progress (the `data-subagent-progress` part `spawn_agent` already streamed, updated in place), then either a **fresh `data-subagent-approval`** when the subagent stops at another gate, or the delegation's result followed by the parent's continuation. Render the response like any turn's stream and a second gate shows up as a second card, with no reload. A failure during the resume arrives as an `error` chunk in that stream.

## Runs with nobody there

`runAgent` runs a turn with no client consuming the stream, so there is no one to ask. It defaults to **`blockGated: true`**: approval-gated tools are stubbed rather than executed, and the agent is told they were unavailable. That's the safe default — an unattended turn can't quietly perform the very actions you gated.

```ts
// Gated tools are stubbed — the agent works around them.
await runtime.runAgent({ principal, agent: "reporter", prompt });

// Opt in to executing them unattended. You are asserting no human is needed.
await runtime.runAgent({ principal, agent: "reporter", prompt, blockGated: false });
```

Set `blockGated: false` deliberately, for agents whose gated tools are safe to run without a human — a scheduled report that must actually send. It is the one place where "autonomous" and "approved" are the same decision.

> **Reversibility is architectural**
>
> An agent can only offer undo if the harness kept a checkpoint. "Approve the irreversible, make the rest reversible" is good design advice that depends on infrastructure you have to have built first — the log is what makes it possible here.

## Next

- [The chat UI](./chat-ui.md) — the continuation protocol your UI has to follow
- [Run agents on a schedule](./schedules.md#when-a-fire-stops-for-a-human) — a scheduled run that stops for a person
- [defineAgent](../reference/define-agent.md) — `toolApproval` as a function, with reasons
