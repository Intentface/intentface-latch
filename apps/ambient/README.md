# Ambient channel agents (the simple version)

One Latch agent per Slack channel that **wakes on a schedule, reads what is new,
keeps an honest state document of the channel, and speaks only through a tool**.
It is not a chatbot: its replies are an internal monologue nobody in Slack sees.
The channel only hears from it via `post_to_channel`, on a budget.

This is also a test of Latch from the outside: a Hono + SQLite app built on the
published package surface alone, in a shape the platform does not use.

## What it does each tick

1. `read_new_messages` — top-level messages since its cursor (thread replies on demand via `read_thread`).
2. Thinks out loud (the assistant text of the run).
3. `update_state` — rewrites its state document: open questions, commitments, decisions, watching, notes to self.
4. Speaks only if addressed, or a commitment is overdue, or an open question has a known answer, or a decision contradicts an earlier one. Unprompted posts are capped per day.

## Run

```bash
cp apps/ambient/.env.example apps/ambient/.env   # fill in the token, channels, a model key
pnpm --filter @intentface/latch-ambient serve
```

Slack app: a bot token with `channels:history`, `channels:read`, `users:read`, `chat:write`,
invited to each watched channel. No event subscriptions, no public URL.

```bash
curl -X POST localhost:8790/channels/C0123/tick        # fire now, through the real cron path
curl localhost:8790/channels/C0123/state               # the document as the agent last wrote it
curl localhost:8790/channels/C0123/monologue           # what the last tick read, thought and did
curl localhost:8790/channels/C0123/runs                # status, tokens, cost per tick
```

Set `AMBIENT_ADMIN_TOKEN` to require `Authorization: Bearer …` on those routes.

## How it maps onto Latch

| Need | Latch piece |
| --- | --- |
| One partition per channel | `Principal = { channel }`; owner key is the channel id. No org, no user. |
| Waking up | `runtime.schedule()` per channel at boot (idempotent); fires via `runtime.cron()` every 30 s in-process. |
| State into the prompt | `context.build` loads the document; the agent factory renders instructions from it each turn. |
| Tools that cannot escape the channel | Every tool reads the channel from `options.context.principal`, never from model input. |
| Cost ceiling | `limits`: one token budget per channel per day. |
| Observability | `telemetry.onRunFinished` logs status, trigger and tokens; `/runs` and `/monologue` read the run log. |
| Durability | Default on via `createLatchHonoApp`; a tick interrupted by a restart resumes on the next cron. |

### State in the channel canvas (`AMBIENT_STATE=canvas`)

The document can live in the **channel's canvas** instead of SQLite. Everyone in the channel sees what the
agent believes and can fix it in place; the agent reads the canvas before every tick and is told what
changed since it last wrote ("removed: … / added: …"), treating human edits as corrections it must keep.

- Read path: `files.info` on the canvas id → `url_private_download` → HTML with the bot token → markdown.
  Slack documents no read method; this is the path every working client uses. Unverified here against a
  real token — the first run against your workspace is the spike.
- Write path: `canvases.edit` with one `replace` of the whole document.
- The canvas is created on first contact (`conversations.canvases.create`) if the channel has none.
- SQLite still keeps the cursor, the post log, and a **shadow** of the last written document: it is what
  makes edits visible and the fallback when the canvas cannot be read.
- Extra scopes: `canvases:read`, `canvases:write`, `files:read`.

State is **not** the memory package. Memory extracts facts after the fact by inference. Here the agent is the
only writer, the write happens inside the turn, and what it wrote is exactly what it reads next time.
Two host tables (`ambient_channel_state`, `ambient_posts`) live next to Latch's in the same SQLite file.

## Tests

```bash
pnpm --filter @intentface/latch-ambient test
```

`tick.test.ts` runs a whole tick with a scripted model and a fake Slack: schedule → cron → factory with
state → tools → state saved → next tick's instructions carry it. No network.

## Known limits of the simple version

- **Pull, not push.** Up to one cadence of delay before it notices anything. Reactions and edits are invisible.
- **Each tick is a fresh chat.** The state survives; the thinking does not. Read `/monologue` for the last one.
- **Cursor advances on read.** A tick that fails after `read_new_messages` loses those messages from the
  agent's view (the state document still holds what it knew). Acceptable for notes; not for anything exact-once.
- **Mentions are not special.** The bot has no event path, so an @-mention is just a message it will see on
  the next tick and may answer then.

Next steps, each additive: an events route feeding an inbox table (replaces the poll), a cheap judge that gates
the expensive turn, one long-lived chat per channel for the monologue, reactions as signal.
