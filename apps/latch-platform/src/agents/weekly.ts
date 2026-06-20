import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";

/**
 * The Weekly Brief agent — prepares Intentface's Monday weekly. It's a weekly
 * *opener*, not a control point: a shared situational picture so everyone can
 * run their week. Team-first, transparent, correction-oriented — never
 * micromanagement. The marquee cron use case (schedule it Mondays 06:30 UTC to
 * pre-build the brief).
 *
 * Connections: Loredex today. The real data sources (Clockify billable, Zero
 * CRM pipeline, Google Calendar holidays, Circleback prior action items) get
 * added as connections later — the agent picks them up with no change here.
 */
export const weekly = defineAgent<Principal, { orgId: string }>(
  () => ({
    model: anthropic("claude-sonnet-4-6"),
    instructions: [
      "You prepare Intentface's weekly meeting brief. The weekly is a shared",
      "situational picture so the team can run the week smoothly — NOT a",
      "reporting ritual or a control point. Tone: team-first, transparent, and",
      "correction-oriented. When someone is behind, ask what would help, never",
      "why they're behind. Keep it tight.",
      "",
      "Produce a brief with these sections (omit a section if there's nothing):",
      "1. Open floor & blockers — surface anything to raise, blockers, who needs help.",
      "2. Billable tracker — per project/person: logging rate vs. elapsed month %,",
      "   who's at risk of falling behind, and the pace (days/day) needed.",
      "3. Allocations & R&D capacity — over/under-allocations; R&D = what's left",
      "   over client work + leave, and whether it's spec'd (not idle).",
      "4. Sales pipeline — deals moving, events, missing contracts.",
      "5. Admin & holidays — leave overlaps and staffing; Clockify/calendar hygiene.",
      "Finish with concrete action items, each with an owner.",
      "",
      "Use available connection tools to gather data when present (Clockify for",
      "billable, the CRM for pipeline, the calendar for leave, prior action items).",
      "Today only the Loredex knowledge base is connected — use loredex_* tools to",
      "pull any documented context, and clearly note where live data is unavailable.",
      "The brief is a basis for discussion, not a verdict.",
    ].join("\n"),
    connections: ["loredex"],
    smoothStream: true,
  }),
  {
    title: "Weekly Brief",
    description:
      "Prepares the Intentface weekly: open floor, billable tracker, allocations & R&D, sales, admin.",
  },
);
