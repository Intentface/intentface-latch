# @intentface/latch-script

The script engine behind Latch agent extensions. Implements `@intentface/latch-core`'s
dependency-free `scripts` seam so an agent can run a script over its tools **before
the model** — fetch the hours, the open PRs, the customer record — and render the
result into the prompt with a Liquid template. Scripts are written in a JavaScript
subset that [callscript](https://github.com/vercel-labs/callscript) parses into an
inert JSON plan: nothing the author wrote executes as code, so there is no sandbox,
and the plan is validated completely before a single tool fires.

## Wiring

```ts
import { createRuntime } from "@intentface/latch-core";
import { createScriptEngine } from "@intentface/latch-script";

const runtime = createRuntime({
  // …storage, agents, etc…
  scripts: createScriptEngine(),
});
```

Then an agent declares extensions:

```ts
defineAgent({
  model,
  instructions: "You write crisp weekly reports.",
  connections: ["clockify", "github"],
  extensions: [
    {
      name: "report", // typed as `/report week`
      on: "slash",
      script: `
        const hours = await clockify_getTimeEntries({ period: input.args });
        const prs = await github_listPullRequests({ state: "merged" });
        return { hours, merged: prs.length };
      `,
      template: `Write the weekly report for {{ input.args }}.
{% for h in output.hours %}- {{ h.member }}: {{ h.total }}h
{% endfor %}Merged PRs: {{ output.merged }}`,
    },
    {
      name: "who", // once per chat, into the system prompt
      on: "chat-start",
      target: "instructions",
      scope: "chat",
      script: `return await crm_getContact({ id: input.contactId });`,
      template: `You are talking to {{ output.name }} ({{ output.company }}).`,
    },
  ],
});
```

What happens on a turn: core opens the agent's tools, runs the script over them,
persists the result as a `data-extension` part on the user message, and only then
calls the model — so the model reads exactly what is stored, and a crash-resume
replays the identical prompt. Scripts are read-only unless the extension sets
`allowMutations`: approval-gated tools are refused at analysis time.

## What a script can do

- call any mounted tool by its Latch name: `await clockify_hours({ period })`
- pure transforms between calls: `h.filter(...)`, `h.reduce(...)`, template literals, ternaries
- bounded fan-out: `await Promise.all(items.slice(0, 10).map((i) => tool({ id: i.id })))`
- `try { … } catch (e) { … }` around a call, and `return { … }` to end
- read `input` (`{ args, argv }` for a typed slash invocation, or the structured input)

It cannot loop unboundedly, reassign, `new`, reach globals, or touch prototypes —
those are validation errors with a pointed message, reported before anything runs.

## Templates

LiquidJS with `strictFilters` on. Scope: `input`, `output` (the script's return
value), `steps` (every `const` by name, also spread at the top level), and `error`.
To give the model an image or a PDF, return it under `files`:
`return { summary, files: [{ mediaType: "application/pdf", data: base64 }] }`.

## Options

```ts
createScriptEngine({
  limits: { maxTotalCalls: 50 }, // callscript limits
  liquid: { strictVariables: true }, // LiquidJS options
});
```
