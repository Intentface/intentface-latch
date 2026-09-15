# @intentface/latch-agent-builder

Agents defined as **data**, plus the meta-agent that writes that data. Ship a product where users create and edit their own agents in a chat, without deploying code.

## What it does

- **`AgentRecordSchema`** (`@intentface/latch-agent-builder/record`) — one zod schema for what an agent *is*: name, scope, instructions, model, connections, and capability flags under `exec` (sandbox, memory, authored tools, reasoning effort). The model that writes a record, the editor a user types into, and the validator that guards the save all speak this one shape. The subpath is zod-only and browser-safe, so a form can import it.
- **`normalizeAgentRecord` / `parseAgentRecord`** — the canonical form: name normalization, trimming, deduped memory targets, dropped blanks. Cross-field rules live in the schema, so an org-scoped memory config on a user-scoped agent is rejected once, not in three places.
- **`createAgentBuilder`** — the meta-agent. It reads the host's models, connections and chat history to make grounded proposals, then creates and updates agents through a host-supplied store. Mutations are gated with `user-approval`, so a user sees the exact spec before it persists.
- **`AgentBuilderStore`** — the storage seam. `@intentface/latch-drizzle` ships an implementation; a host with its own tables can satisfy it directly.
- **`AgentBuilderExtension`** — the feature seam. Evals, tool authoring, memory schemas and connection management plug in as extensions, so a host without the feature gets a builder that never mentions it.

## Usage

```ts
import { createAgentBuilder } from "@intentface/latch-agent-builder";

const builder = createAgentBuilder<Principal>({
  model,
  // Lazy and per-principal, so the composition root has no import cycle.
  deps: async (principal) => ({ runtime, store, models, connections }),
  extensions: [evalsExtension, toolAuthoringExtension],
});
```

Register it like any other agent, and the records it writes resolve into live agents through the store.

## Where it fits

Sits on `@intentface/latch-core` — the records it produces become agent factories the runtime can run. Pair it with `@intentface/latch-drizzle` for the store.
