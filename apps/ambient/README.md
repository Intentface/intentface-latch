# Ambient channel agents

One Latch agent per Slack channel the bot is a member of. Slack events land in an inbox; after a quiet
period (or at once for a mention) the channel's tick runs as **one more turn of one long-lived chat** — the
agent's continuous monologue, compacted as it grows — which reads the inbox, keeps an honest **state
document** of the channel (open questions, commitments, decisions), and speaks only through `post_to_channel`,
on a daily budget. It is not a chatbot: nobody in Slack sees its thinking.

This is also a test of Latch from the outside: a Hono + SQLite app on the public package surface alone.

## How it works

```
Slack events ──▶ POST /slack/events ──▶ inbox (SQLite) ──▶ ticker (quiet 90 s, or now for a mention)
                                                                │
                              runtime.runAgent(threadId = ambient_<channel>)  ◀── one chat per channel
                                                                │
                   read_inbox → think → update_state → (post_to_channel)   ◀── the four tools
```

- **Which channels:** the ones the bot is in. `/invite` starts watching, `/kick` stops. Membership is listed at
  boot and kept current by `member_joined_channel` / `member_left_channel`.
- **What it sees:** messages, thread replies, edits, deletions, reactions added/removed, mentions — normalized
  into observations. A ✅ on a recorded commitment closes it; 👀 on its own post means "say more". The first look
  at a channel also pulls recent history for context.
- **Links:** the harness's `web_fetch` tool (public pages as markdown, private hosts blocked, 50 KB cap) — used only
  when a link is what a message is about and it bears on something tracked or asked; it records a two-line summary,
  never the page.
- **When it speaks:** addressed (in the thread), a commitment overdue and unmentioned for a day, an open question
  it can answer from the channel's own history, a decision contradicting an earlier one. Never about tone or
  dynamics. Unprompted posts are capped per day.
- **Triage before every tick:** is this batch worth waking the agent *now*? Rules settle the obvious (a mention,
  anything touching what the state tracks, a question or commitment, a stale inbox → act; only reactions on
  untracked messages → defer). Plain human talk goes to a cheap model when `AMBIENT_TRIAGE_MODEL` is set. "No"
  means **defer, never discard**: events stay queued and fold into the next batch; after 30 minutes they are read
  regardless. Every verdict is logged with its reason (`/channels/:id/triage`) and the judge's tokens count against
  the channel's budget like any other spend.
- **Working signal:** while a mention is being handled its thread root gets a 👀 reaction, removed when the tick ends
  whatever the agent decided. Slack's native "is thinking…" status is attempted too, best-effort: Slack documents
  it for DM/assistant threads only (`method_not_supported_for_channel_type` in channels), so the reaction is the
  signal you can rely on.
- **Heartbeat:** an hourly tick on quiet channels, for overdue checks only.

## Run

```bash
cp apps/ambient/.env.example apps/ambient/.env   # bot token, signing secret, a model key
ngrok http 8790                                   # or cloudflared tunnel --url localhost:8790
pnpm --filter @intentface/latch-ambient serve
```

Create the Slack app from [`slack-manifest.json`](./slack-manifest.json) (api.slack.com/apps → Create New App →
From a manifest) with `request_url` set to `https://<tunnel>/slack/events`; Slack verifies it on save. Install,
copy the Bot User OAuth Token and Signing Secret, then `/invite @Ambient` in a channel.

Open **http://localhost:8790/** for the operator page: channels with today's spend against the budget, and per
channel the state document, triage verdicts, runs (tokens, cached, cost, duration, errors), the monologue with
tool calls, and a "Tick now" button. Refreshes every 15 s. With `AMBIENT_ADMIN_TOKEN` set, open `/?token=…` once.

```bash
curl localhost:8790/channels                      # watched channels, queued events, last tick, today's spend
curl localhost:8790/channels/C0123/usage          # today's spend vs budget, resets-in
curl localhost:8790/channels/C0123/state          # the document as the agent last wrote it
curl localhost:8790/channels/C0123/monologue      # the whole long-lived chat: read, thought, did
curl localhost:8790/channels/C0123/runs           # status, tokens, cost per tick
curl localhost:8790/channels/C0123/triage         # why it did or did not wake, with the judge's token cost
curl -X POST localhost:8790/channels/C0123/tick   # run now (a heartbeat if nothing is queued)
```

Set `AMBIENT_ADMIN_TOKEN` to require `Authorization: Bearer …` on those routes.

## How it maps onto Latch

| Need | Latch piece |
| --- | --- |
| One partition per channel | `Principal = { channel }`; owner key is the channel id. No org, no user. |
| The monologue | `runtime.runAgent({ threadId })` continues one chat per channel (created on first use); `compactChat` folds old thinking once it grows. |
| No two ticks interleave | one active run per chat: a concurrent tick gets `ChatBusyError`; the ticker retries. |
| State into the prompt | `context.build` loads the document; the agent factory renders instructions from it each turn. |
| Tools that cannot escape the channel | every tool reads the channel from `options.context.principal`, never from model input. |
| Cost ceiling | `limits`: one budget per channel per day — **cost** (USD, from the catalog's prices) with a token backstop. A refusal parks the queued events until the window turns; the ticker waits the refusal's retry-after instead of hammering. |
| Observability | `telemetry.onRunFinished`; `/runs` and `/monologue` read the run log. |
| Durability | on by default; a tick interrupted by a restart resumes on the next cron sweep, and the inbox is durable. |

### State in the channel canvas (`AMBIENT_STATE=canvas`)

The document can live in the **channel's canvas**. Everyone sees what the agent believes and can fix it in
place; the agent reads the canvas before every tick and is told what changed since it last wrote, treating human
edits as corrections it must keep. Read path: `files.info` → `url_private_download` → HTML → markdown (Slack
documents no read method; this is what every working client does — **unverified here against a real token**).
Write: `canvases.edit` replace. SQLite keeps the inbox, the post log and a shadow of the last written document
(the fallback when the canvas cannot be read).

State is **not** the memory package. Memory extracts facts after the fact by inference. Here the agent is the
only writer, the write happens inside the turn, and what it wrote is exactly what it reads next time.

## Tests

```bash
pnpm --filter @intentface/latch-ambient test
```

State store and inbox, event normalization and the signed route, the debounce ticker (fake timers), the tools,
canvas plumbing, and two ticks through the runtime on one chat with a scripted model and a fake Slack, including
the busy refusal. No network.

## Cost

A tick is one turn of a long chat with several tool steps, and every step resends the whole context, so the
per-tick token count is dominated by what sits in history: earlier tool outputs, fetched pages, the bootstrap
history. Three things keep it bounded: the monologue compacts every ~24 messages (a few ticks), long texts are
clipped before the model sees them, and at most one page is fetched per tick. Prompt caching makes most of those
resent tokens cheap, which is why the budget is in **cost**, not tokens: 500k tokens of a mostly-cached context is
under a dollar. Watch `/channels/:id/runs` for tokens and cost per tick while tuning.

## Known limits

- **Whole-document canvas replace:** a human edit landing between the agent's read and write loses.
- **In-process debounce timers:** a restart forgets pending timers, but not the inbox — a watched channel with
  queued events ticks at boot. A channel that never goes quiet still ticks within four quiet periods (6 min).
- **Bursts fold before the model sees them:** reactions group per message and emoji, add/remove by the same
  person cancels. Messages are not folded; a very busy channel simply gets a longer read.
- **Heartbeat is a plain interval**, not a Latch schedule; on one process that is all it needs.
