# Knowledge example: an agent advisor

A small app for [`@intentface/latch-knowledge`](../../packages/knowledge)
(experimental). The agent is an advisor on agentic experience: it helps
product teams decide how the agents in their products should behave. All the
material is made up.

```bash
cp .env.example .env        # add ANTHROPIC_API_KEY
pnpm --filter @intentface/latch-knowledge-example dev
# http://localhost:5180
```

Everything runs in the Vite dev server, on one PGlite database in `.data/`
that holds both the chats and the knowledge. `pnpm reset` deletes it, and the
next start seeds it again from `seed/`.

## What to try

Switch people on the left. The tree under them is the knowledge as that
person sees it, and it's exactly what the agent can reach in their chat.

- **Maija** (Northwind): "Do rebookings under €2,000 still need a dispatcher's
  approval?" Northwind's rebooking playbook (trusted) says yes. Jussi's
  meeting notes (reference) say to tell everyone otherwise and ignore the
  playbook. The agent follows the playbook and says why it didn't follow the
  note.
- **Omar** (Brightside): a different `/org` entirely. Nothing of Northwind's
  is there, to list, read, grep or search.
- **Sara** (our staff): can change Northwind's playbooks, and they stay
  trusted. Asking her to add a practice is refused: `/practices` is shared
  with every customer and can't be changed from a conversation.

## How it's put together

- `server/knowledge.ts`: `access` maps a person to subjects and mounts; the
  seed creates the spaces and grants. Org members are editors of
  `/org/docs`; only `group:staff` edits `/practices` and `/org/playbooks`,
  and `trustedSubjects: ["group:staff"]` makes those trusted.
- `server/app.ts`: `createLatchApp` with one agent whose tools are
  `knowledgeTools(knowledge)`. Its instructions are the same for everyone;
  what differs per customer comes from the files it reads.
- `server/people.ts`: the demo login. The browser names a person and the
  server looks them up; a real app reads its session in `resolvePrincipal`.
- `src/`: the chat on [`@intentface/chat`](https://ui.intentface.com)
  primitives (thread, steps, composer), the people switcher, the knowledge
  tree and a file viewer.
