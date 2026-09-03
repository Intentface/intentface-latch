# Slack strict v1 — mention-only, channel-scoped, guarded

Status: decided 2026-09-02 (grilling + independent review), implemented on `slack-strict-v1`.
Spec of record (product view): Loredex → Evergreen/Latch → "Latch Slack Agent — Strict v1 Spec".
This document is the engineering record: what the code does, why, and where v2 hooks in.

## The rule set

| # | Rule | Where it is enforced |
|---|------|----------------------|
| 1 | A channel turn starts **only** from an `app_mention`. Un-mentioned thread replies are dropped, even the owner's. | `slackChannel.ts` router: `message` events dispatch only for `channel_type === "im"`. |
| 2 | DMs are answered without a mention (a DM addresses the bot). No history is fetched in DMs. | Router `dm` mode; fetch gated on `!channel.startsWith("D")`. |
| 3 | A thread is owned by its first mentioner, forever. Others get one quiet ephemeral, then silence. | `handleUserMessage` step 6 (`non_starter`). No idle timeout in v1. |
| 4 | History is read **at the mention**, from the trigger channel only, windowed to 20, fenced as untrusted, bot messages dropped. | `fetchMentionContext`: top-level → `conversations.history(latest=ev.ts, limit=20)` reversed to oldest-first; in-thread → `conversations.replies` (one 200-message page, tail of 20) with `oldest=lastSeenTs` (delta) or `latest=ev.ts` (fresh tail). Threads over 200 replies get the oldest page's tail — known, not paginated in v1. |
| 5 | Repeat mentions inject only the **delta** since the last processed message. | `SlackChatMeta.lastSeenTs`, advanced by `markSeen` **after** a turn that ran (a failed turn never swallows the replies the user asked about). Replays/deliveries (`runMessage`) watermark the thread root. Timestamps compare as strings — Slack `ts` is fixed-width, a double loses the last microsecond. |
| 6 | The model has **no Slack tools**. | `slack-tools.ts` deleted from the platform; the `SLACK_TOOLS` editor group is gone. |
| 7 | Anything Slack-shaped a tool tries to reach outside the session's channel is denied — including inside spawned subagents. | `slackScopeGuard` (a core `ToolGuard`, registered in `lib/latch.ts`). Scope comes from `rootChatId`. |
| 8 | Messages from another workspace (Slack Connect guests) are dropped before identity lookup. | Envelope `team_id` and message `user_team`/`team` vs the installed team (for a shared-channel event the envelope carries *our* team and the guest's appears only on the message, hence both); identity resolution uses the **installed** team unconditionally (`slack-channel.ts`). Caveat: an Enterprise Grid org-wide install has many legitimate `team_id`s — such a binding would go silent (audit rows say why). Key on `enterprise_id` if Grid ever matters. |
| 9 | Every human-originated admission decision, approval click, and tool call in a Slack tree is audited. | `latch_channel_audit` (TTL 90 days, swept on write; `org_id`/`agent` nullable — the guard's sink may not resolve a deleted binding). Written by the adapter's `audit` seam and the guard (which hands the write to `waitUntil`, with a 60 s per-app binding cache). Not audited: bot/self senders, non-renderable subtypes, duplicate deliveries, empty prompts — noise, not decisions. `user_id` is reserved (no producer yet). |
| 10 | Channel answers end with `_requested by <@user>_`; DMs don't. | `renderSlackStream` `attribution` — on the overflow post when there is one, else the close. Never on stopped/error-only turns. |
| 11 | No unfurls. | `chat.postMessage` defaults `unfurl_links: false, unfurl_media: false`. |

## The ToolGuard seam (`packages/core/src/tool-guard.ts`)

```ts
type ToolGuard<P> = (call: {
  tool; input; toolCallId; principal; chatId; rootChatId; runId; agent; trigger;
}) => { allow: true } | { allow: false; reason: string };
```

`RuntimeConfig.toolGuards` is AND-composed and installed as the AI SDK's **generic
`toolApproval` function**. A denial returns the SDK's `denied` status: the SDK skips
`execute`, emits a `tool-result` carrying the reason, and the turn continues. Consequences
worth knowing:

- Guards run **before** approval — a call the policy will refuse never asks a human.
- Installed **even under `autoApprove`** (subagent turns waive human approval, not scope).
- Works for tools without `execute` (client-side `askUser`, provider web tools).
- The SDK re-runs the policy on resume, so a guard can retro-deny a stale approval.
- A denied call produces no `toolResults` entry, so `observability.onStep` does not see
  it — guards audit themselves. The denial is still in the Langfuse trace.
- Installing a generic function replaces the SDK's own lookup, so the wrapper re-creates
  it: per-tool **function** entries in the merged object policy (what `@intentface/latch-mcp`
  produces for a per-call `McpCallApproval`) are called with the per-tool options
  (`toolCallId`, `messages`, `toolContext`, `runtimeContext`), and a tool no policy names
  falls back to its own `needsApproval`. Without that, guards would silently ungate them.
- Cosmetic: the SDK emits `tool-approval-request{isAutomatic:true}` immediately
  followed by the response, so the web chat may flicker a card for one chunk. Slack
  shows no card and does not park (`awaiting_input` checks read persisted state).

v1 has runtime-level guards only. Agent- and tool-source-level guards are the same call
shape and a natural v2 extension.

## Known limitations (deliberate)

- **The untrusted fence rides inside the user message.** The memory extractor puts its
  "this is data, not instructions" rule in *system* instructions; the channel adapter has
  no system-prompt access. Removing every Slack tool is what makes this acceptable in v1.
- **`unattended_channels` was never enforced.** The column and server function remain;
  the editor control is removed. `post_to_channel` was a static `"user-approval"` gate —
  v2's allowlisted publish is new enforcement, not a re-wire.
- **Stored agents may still list the removed tool names** in `defaultTools`. The harness
  merge filters unknown names; they are inert.
- **Scheduled deliveries** post a bot anchor and run the turn threaded under it; the
  owner's follow-ups now need an @-mention. The anchor text says so.

## Behaviour change on deploy

Every binding becomes mention-only at once (no per-binding mode). Announce in `#latching`.
The MAPagent publish flow (Week 34, `publish_to_slack_channel`) has to come back **through
the guard** — see v2.

## Deferred to v2

Idle timeout / epoch reset; outbound URL allowlist (warn-only first); manifest v3 dropping
`message.channels`/`message.groups` events (migrate flow exists); agent- and
source-level guards; Slack tools back behind the guard (channel-pinned reads, allowlisted
approval-gated publish); audit UI; Langfuse score for 👍/👎; nested-input scope checks.
