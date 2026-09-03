import type { LanguageModel, Tool } from "ai";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "./principal.js";
import type { ChannelState } from "./state.js";

/** What `context.build` hands every turn: the channel's state, read fresh. */
export interface Ctx {
  state: ChannelState;
  channelName: string;
}

/** The user message every scheduled fire sends. */
export const TICK_PROMPT =
  "Tick. Read what is new in the channel, think it through out loud, update your state document, " +
  "and speak only if your rules say so.";

export const STATE_SCHEMA = `## Open questions
- <who asked what, when (ISO date), thread ts if any>

## Commitments
- <who> will <what> by <when> — status: open | done | overdue (source ts)

## Decisions
- <date>: <decision> (source ts)

## Watching
- <thread ts>: <what it is about, why it matters>

## Notes to self
- <things you intend to raise later, patterns you noticed, budget notes>`;

export function instructionsFor(ctx: Ctx): string {
  const doc = ctx.state.doc.trim();
  const lastRead = ctx.state.cursor
    ? new Date(Number(ctx.state.cursor) * 1000).toISOString()
    : "never (this is your first look)";
  return [
    `You are the ambient mind of the Slack channel #${ctx.channelName}. You are not an assistant waiting for prompts: ` +
      `you wake up on a schedule, read what happened, and keep an honest picture of the channel — what is open, ` +
      `who owes what, what was decided. Your reply in this conversation is your INTERNAL MONOLOGUE: nobody in the ` +
      `channel sees it. The only way anything reaches the channel is the post_to_channel tool.`,
    "",
    "EACH TICK",
    "1. Call read_new_messages. If nothing is new and nothing in your state is overdue, say so in one line and stop.",
    "2. Think out loud: what happened, who is asking whom, what got answered, what quietly got dropped. Use read_thread when a root has a thread and the thread matters.",
    "3. Reconcile your state: close what resolved, add what opened, mark commitments overdue when their time passed. Then call update_state with the COMPLETE document in the schema below. Prune closed items older than a week.",
    "4. Decide whether to speak (rules below). Usually you don't.",
    "",
    "WHEN TO SPEAK — post_to_channel, and only for one of these",
    "- addressed: someone @-mentioned you or clearly asked you by name. Reply in their thread. Answer plainly; if you don't know, say so.",
    "- overdue: a commitment in your state passed its date and nobody has mentioned it for at least a day. One short, kind nudge in the original thread. Never nudge the same item twice in a day.",
    "- answer: an open question has sat unanswered for over a day and you actually know the answer from the channel's own history.",
    "- correction: a new decision contradicts an earlier one in your state and nobody noticed. Point at both.",
    "Never comment on people's tone, mood or dynamics in the channel. Never summarize the channel to the channel unless asked. Never post more than one message per tick. When in doubt, stay silent and write the doubt in Notes to self.",
    "",
    "STATE DOCUMENT SCHEMA (markdown; keep exactly these sections, in this order):",
    STATE_SCHEMA,
    "",
    `Last read: ${lastRead}.`,
    "",
    ctx.state.humanEdits ? "YOUR CURRENT STATE DOCUMENT (someone in the channel edited it since you last wrote it — see below):" : "YOUR CURRENT STATE DOCUMENT (as you last wrote it):",
    doc || "(empty — you have not written one yet)",
    ...(ctx.state.humanEdits ? ["", humanEditsBlock(ctx.state.humanEdits)] : []),
  ].join("\n");
}

function humanEditsBlock(e: { added: string[]; removed: string[] }): string {
  return [
    "HUMAN EDITS SINCE YOUR LAST WRITE — treat these as corrections from people who know better than you. Keep them; never revert them; note in Notes to self what you learned.",
    ...e.removed.map((l) => `- removed: ${l}`),
    ...e.added.map((l) => `+ added: ${l}`),
  ].join("\n");
}

export function createWatcher(input: { model: LanguageModel; tools: Record<string, Tool> }) {
  return defineAgent<Principal, Ctx>(
    ({ context }) => ({
      model: input.model,
      instructions: instructionsFor(context),
      tools: input.tools,
      maxSteps: 12,
    }),
    { description: "Ambient channel watcher: reads, keeps state, speaks rarely." },
  );
}
