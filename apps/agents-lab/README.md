# Agent Lab

A workbench for `@intentface/agents-sdk`. Real sign-in, real organizations, and
every claim the SDK makes visible on screen rather than only in a test.

Delete it when the experiment ends; nothing else depends on it.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-…' > apps/agents-lab/.env.local
pnpm --filter agents-lab dev     # http://localhost:3200
```

The dev script builds the SDK and runs the better-auth migration first. Create
an account on the sign-in page; you get a personal organization automatically.

State lives on disk in `apps/agents-lab/.data/`, gitignored — auth tables,
conversations and the spend ledger in one SQLite file. It survives a restart,
including a `kill -9`. Delete the directory to start clean.

It runs in WAL mode, so the directory holds three files and **most of your data
is in `lab.db-wal`, not `lab.db`**. Copying the main file alone gives you a
database with no tables in it. Copy the directory, or run
`PRAGMA wal_checkpoint(TRUNCATE)` first.

## What it is for

Everything here is an extension in `lib/agent.ts`. The route does one thing:
call the loop. The app exists to make that visible.

| Tab | Shows |
|---|---|
| Chat | The conversation, on `@intentface/chat` primitives |
| Spend | Org and personal ceilings against the ledger they are enforced from |

Four of the extensions are ports of pi examples, which map almost one-to-one
onto our moments:

| pi example | Here | Moment |
|---|---|---|
| `dynamic-tools` | destructive tools stay hidden until the agent has looked | `step_start` → `activeTools` |
| `truncated-tool` | a huge tool result is cut, and the model is TOLD it was cut | `tool_result` |
| `summarize` | a summary inserted at the boundary; the model reads from there, the reader still sees everything | `before_agent_start` + `context` |
| `send-user-message` | a run ending on "let me check that" is revived once | `follow_up` |

| Type this | What it proves |
|---|---|
| `/` | The slash palette, DERIVED from what the extensions registered — `/api/commands` calls `listCommands`, so the menu cannot drift from the registry |
| `/help` | A command answered with no model call. Watch it return in single-digit milliseconds |
| `/tidy` | A command that rewrites your prompt and lets the model run |
| `/compact` | Summarise the conversation now, without waiting for the threshold |
| `/whoami` | A browser tool: the run ends, your browser answers, the run resumes |
| "delete old-backup.zip" | An extension vetoes the call before it executes |
| "delete notes.md" | The run **ends** and waits for you; approve or deny |
| "delete a.md and b.md" | Two approval cards at once |
| "ask me my favourite colour" | A browser tool that waits for a person |
| "delete notes.md" as your FIRST message | `deleteFile` is not even offered until the agent has listed the workspace |
| "list the files, then delete notes.md" | Same conversation, tool unlocked, approval fires |
| reload the page | The transcript comes back, view rules and all |

The approval case is the one worth watching. Nothing is held open on the server
while you decide. The run finishes, the unanswered tool call in the transcript
is the whole suspended state, and approving starts a fresh run over the longer
message list. Close the tab, restart the server, come back, approve.

## Identity

`lib/principal.ts` declares the principal's shape once, by augmenting the SDK's
`Principal`, which is why nothing downstream carries a generic. The isolation
key is the organization:

```ts
export const owner = (p: LabPrincipal) => p.orgId;
```

Conversations and budgets belong to an org, so a leaked chat id from another
org returns an empty transcript rather than someone else's conversation. That
is enforced in the persistence extension's SQL, not in the UI.

Every user gets a personal organization (`user:<id>`) at sign-up, and lands in
it until they belong to a real one.

One rule is carried from `latch-platform` because getting it wrong splits a
tenant in half: **the active organization must be pinned on session create**. A
session with no active org resolving to a personal tenant means the same user's
data lands under two owners.

Worth knowing, because it bit me here: the session hook cannot cover the FIRST
session. At sign-up, `session.create.before` runs before `user.create.after`
has created the personal org, so that one session is left unpinned. Every later
sign-in is pinned correctly. `currentPrincipal` therefore resolves in order —
the session's pinned org, then actual membership, then the personal id as a
last resort — rather than reaching straight for `user:<id>` when unpinned,
which would send a member of a real org to their personal tenant instead.

## The design system

Tokens, the chat primitives and their styled layer come from
[intentface-chat](https://github.com/Intentface/intentface-chat) rather than
being approximated here: `app/globals.css` is that repo's token file, and
`components/ai/` is its styled layer. Four seeds (`--bg`, `--fg`, `--acc`,
`--con`) drive every surface through `color-mix` in OKLCH.

`Shell`, `Nav` and `Tabs` are NOT used — they exist only on that repo's
unmerged `feature/app-shell-primitives` branch, and pinning an app to a branch
is worse than the small amount of layout written here.

## Known rough edges

- The model is `claude-sonnet-5` unless `AGENTS_LAB_MODEL` says otherwise.
- Ceilings are deliberately small so they are easy to hit: `AGENTS_LAB_ORG_LIMIT`
  (default 1.00) and `AGENTS_LAB_USER_LIMIT` (default 0.25).
- No invitation flow. Everyone lands in their own personal organization; to test
  two members in one org you have to add a `member` row by hand.
- SQLite means one process. The lease is real but only exercised across
  concurrent requests to the same server.
- Compaction never deletes anything and never shows you the summary. A marker
  is inserted at the boundary, rendered as a divider reading "N earlier
  messages summarised for the model"; the turns it covers are still above it to
  read. The summary prose exists only as data on that marker and is prepended
  to the MODEL's view as a synthetic turn that is never stored.
  `AGENTS_LAB_COMPACT_AFTER` sets the threshold.
