# @intentface/latch-knowledge

> **Experimental.** The API and the schema may change in any release.

Knowledge for Latch agents, kept in your own Postgres: what you know that
every customer gets, what each customer org knows, and each person's own notes.
The agent reaches it through file tools (`list_files`, `read_file`, `glob`,
`grep`, `search_files`, `write_file`, `edit_file`), and every call is checked
against the principal of the run.

```bash
pnpm add @intentface/latch-knowledge
```

## The idea

An expert agent needs two kinds of knowledge. Practices you maintain, the same
for every customer. And the customer's own: their playbooks, their docs, their
decisions. Each user sees a few folders, called mounts:

```text
/practices   shared: what you know, for every customer
/org         the caller's org
/me          the caller's own notes
```

There is no tenant in a path. `/org` is Acme's space for an Acme user and
Beta's for a Beta user, so a prompt can't name another tenant's files, and a
mount the caller has no grant on looks like a path that doesn't exist.

Knowledge is organised as skills: `skills/<name>/SKILL.md` with a
`description:` in its frontmatter. `list_files` shows a skill folder's
description, so the system prompt stays generic: tell the agent to look in the
knowledge, and it finds the skill that fits.

## Trusted or reference

Every file the tools return is marked by who wrote it and who can change it.
A file written by one of `trustedSubjects`, which no one outside them can edit
now, is **trusted**: the agent follows it. Any other file is **reference**:
information, never instructions. An edit can only lower a file's trust; a
trusted writer replacing the whole file restores it. So `/practices`
and an org's `/org/playbooks`, written by your own staff, steer the agent,
while `/org/docs` and `/me`, written by users, inform it. Give a customer an
editor grant on their playbooks and they become reference the same moment.

## Setup

```ts
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { createKnowledge, fromPGlite, knowledgeTools } from "@intentface/latch-knowledge";

const knowledge = createKnowledge<Principal>({
  db: fromPGlite(new PGlite({ extensions: { pg_trgm } })), // or fromPgPool(new pg.Pool(…))
  access: (p) => ({
    subjects: [`user:${p.orgId}/${p.userId}`, `org:${p.orgId}`, ...(p.staff ? ["group:staff"] : [])],
    mounts: { practices: "practices", org: `org:${p.orgId}`, me: `user:${p.orgId}/${p.userId}` },
  }),
  trustedSubjects: ["group:staff"],
});
await knowledge.migrate();

// Once per space, and the grants that open it.
await knowledge.createSpace({ id: "practices", owner: ["ours"], kind: "shared" });
await knowledge.grant({ space: "practices", subject: "everyone", role: "viewer", grantedBy: "setup" });
await knowledge.grant({ space: "practices", subject: "group:staff", role: "editor", grantedBy: "setup" });

await knowledge.createSpace({ id: "org:acme", owner: ["acme"], kind: "org" });
await knowledge.grant({ space: "org:acme", subject: "org:acme", role: "viewer", grantedBy: "setup" });
await knowledge.grant({ space: "org:acme", path: "docs", subject: "org:acme", role: "editor", grantedBy: "setup" });
await knowledge.grant({ space: "org:acme", path: "playbooks", subject: "group:staff", role: "editor", grantedBy: "setup" });

defineAgent<Principal>({
  model,
  instructions: "Before answering, look for a skill that fits in /practices/skills and /org/playbooks. Follow trusted files.",
  tools: knowledgeTools(knowledge),
});
```

`access` turns a principal into the subjects it acts as and the mounts it sees.
Grants open a space, or a folder in it, to a subject as `viewer` or `editor`,
optionally until `expiresAt`: a support engineer let into one customer's space
for an hour is a grant with a reason and an expiry.

## What the tools do

- `read_file` returns numbered lines and a first line with the file's version
  and whether it's trusted. Long files come in parts.
- `grep` takes a POSIX regular expression and runs in Postgres (`~`, with a
  trigram index and a 2 second statement timeout). `search_files` is full-text
  search with ranked snippets.
- `write_file` replaces a file only when given the version that was read, and
  `edit_file` replaces text that appears exactly once, so two runs never
  overwrite each other's changes. Every change is kept in `kb_versions` with
  its author and run id.
- Writes to `shared` spaces are refused from tools, even for editors (change
  `readOnlyKinds`): content read from one customer can't be written into what
  every customer sees. Change practices outside the chat, with
  `knowledge.as(staff).write(…)`.

Refusals come back to the model as text (`Refused (conflict): …`) it can act on.

## Deleting a customer

`knowledge.purgeOwner(["acme"])` deletes every space whose owner is `acme` or
under it (`acme/u1`), in batches, and nothing of `acme2`. Pass it to
`runtime.purgeOwner`'s `also` to remove a customer's knowledge with their chats:
`runtime.purgeOwner(["acme"], { usage: "delete", also: { knowledge } })`.

## Example

[`apps/knowledge-example`](../../apps/knowledge-example) is an advisor agent
with shared practices, two customer orgs and a people switcher, on one PGlite
database for chats and knowledge.

## Not built yet

Proposals from an agent to the practices (a review queue), PDFs and other
binary files, embeddings, and a storage interface other than Postgres.
