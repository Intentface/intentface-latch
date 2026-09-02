import { tool } from "ai";
import { z } from "zod";
import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import { parseAgentRef } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import type { ScheduleDelivery } from "@/lib/schedule-delivery";

/**
 * Builder extension: delivery-aware schedules. Replaces the package's plain
 * schedule tools (`scheduling: false` on the builder) with ones that can push
 * each run into a channel the user is entitled to. The builder can schedule
 * ANY of the user's agents, unlike the harness `create_schedule` (which only
 * ever schedules the agent it's running as). That's also why this is the one
 * place a delivery target is named by the model: this is a web chat, so there
 * is no channel to derive one from. Safe because every target is checked
 * against `list_agent_channels` and then re-checked by `resolveDelivery` — and
 * the whole call pauses for approval with the spec echoed on the card.
 */

const PROMPT = `SCHEDULES (create_agent_schedule / list_agent_schedules / delete_agent_schedule):
An agent runs as one TURN per trigger — it cannot loop in the background. For "do X every …" or "do X at …", save the agent to do X ONCE per run, then put it on a schedule. Design scheduled agents to complete in one self-contained turn from the schedule's prompt alone. A scheduled run has no user watching — if it hits an approval-gated (write) tool it PAUSES until the user reviews that chat, so warn the user when scheduling a write-capable agent.
- To make an agent run on a cadence, use create_agent_schedule. Always call list_agent_channels FIRST when the user wants the result delivered somewhere ("message me on Telegram", "post it to #general") and pass one of its entries as deliverTo — invented refs are rejected.
- No channels listed means the user hasn't linked that agent's bot (or doesn't own its Slack app). Say so and offer the app-only schedule; don't guess an id.
- An agent with defaultTools can also schedule ITSELF from its own conversation — into that same channel by default, or into any of its own list_delivery_channels entries (so a web-chat conversation can still set up a Telegram push). Prefer that when the user is really asking "have this agent ping me" and the agent is one they already talk to.
- Recurring behavior is a SCHEDULE — never promise loops or timers inside an agent.`;

export const schedulesExtension: AgentBuilderExtension<Principal> = {
  name: "schedules",
  promptSections: [PROMPT],
  toolApproval: {
    // Schedules persist a recurring run and, with a delivery target, a
    // recurring push into someone's DM or a team channel.
    create_agent_schedule: "user-approval",
    delete_agent_schedule: "user-approval",
  },
  tools: async (principal) => {
    const { getLatch } = await import("@/lib/latch");
    const { runtime } = await getLatch();
    return {
      list_agent_channels: tool({
        description:
          "The channels a scheduled run of this agent could be delivered to — the Telegram and " +
          "WhatsApp bots the user has linked and the Slack apps they own, with each app's channels. Call this " +
          "before create_agent_schedule; deliverTo values not listed here are rejected.",
        inputSchema: z.object({ agent: z.string().describe("Agent name from list_agents.") }),
        execute: async ({ agent }) => {
          const { listAgentChannels, deliveryOptions } = await import("@/lib/schedule-delivery");
          const channels = deliveryOptions(await listAgentChannels(principal, agent));
          // Count the ENTRIES, not the apps: a Slack app whose channels couldn't
          // be listed (missing token or scope) yields no entries, and without this
          // the model would get an empty list and no explanation for it.
          return {
            channels,
            note:
              channels.length === 0
                ? "No channels available — a schedule for this agent will run in the app only."
                : undefined,
          };
        },
      }),

      create_agent_schedule: tool({
        description:
          "Schedule one of the user's agents to run on a cron expression (omit `cron` for a " +
          "one-off on the next tick), optionally delivering each run into a channel. Pauses for " +
          "the user's approval.",
        inputSchema: z.object({
          agent: z.string().describe("Agent name from list_agents."),
          cron: z.string().optional().describe("5-field cron, e.g. `0 8 * * 1-5`. Omit for a one-off run."),
          timezone: z
            .string()
            .optional()
            .describe("IANA timezone the cron is read in, e.g. `Europe/Helsinki`. Defaults to UTC."),
          prompt: z.string().describe("The message the agent receives on each fire."),
          deliverTo: z
            .object({
              kind: z.enum(["telegram", "whatsapp", "slack"]),
              ref: z.string().describe("The `ref` from list_agent_channels (bot id / Slack app id)."),
              channel: z.string().optional().describe("Slack only: the channel id from list_agent_channels."),
            })
            .optional()
            .describe("Omit to run in the app only (no channel push)."),
        }),
        execute: async ({ agent, cron, timezone, prompt, deliverTo }) => {
          const { resolveOfferedDelivery, DeliveryError } = await import("@/lib/schedule-delivery");
          const { checkScheduleLimits } = await import("@/lib/schedule-limits");
          // The same cap and frequency floor the harness `create_schedule`
          // applies. Both are model-driven, so both need them — the builder is
          // if anything the wider surface, since it can schedule ANY agent.
          const rejected = await checkScheduleLimits(runtime, principal, cron?.trim() || null, timezone);
          if (rejected) return { error: rejected };

          let delivery: ScheduleDelivery | undefined;
          let deliversTo = "app only";
          if (deliverTo) {
            // Rejects hallucinated references (only what discovery returned) and
            // re-checks the entitlement — the same guard the harness
            // `create_schedule` uses for its own `deliver_to`.
            try {
              const offered = await resolveOfferedDelivery(principal, agent, deliverTo);
              if (!offered) {
                return {
                  error: `Unknown channel for agent "${agent}". Use list_agent_channels and pass one of its entries.`,
                };
              }
              delivery = offered.delivery;
              deliversTo = offered.label;
            } catch (e) {
              return { error: e instanceof DeliveryError ? e.message : "Delivery target rejected." };
            }
          }
          try {
            const created = await runtime.schedule({
              principal,
              agent,
              cron: cron?.trim() || null,
              timezone,
              prompt,
              delivery,
            });
            return {
              id: created.id,
              agent: created.agent,
              cron: created.cron ?? "one-off",
              timezone: created.timezone ?? "UTC",
              nextRunAt: new Date(created.nextRunAt).toISOString(),
              deliversTo,
            };
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Failed to create the schedule." };
          }
        },
      }),

      list_agent_schedules: tool({
        description: "The user's scheduled runs, optionally filtered to one agent.",
        inputSchema: z.object({ agent: z.string().optional() }),
        execute: async ({ agent }) => {
          const all = await runtime.listSchedules({ principal });
          const wanted = agent ? parseAgentRef(agent).name : undefined;
          return {
            schedules: all
              .filter((s) => !wanted || parseAgentRef(s.agent).name === wanted)
              .map((s) => ({
                id: s.id,
                agent: s.agent,
                cron: s.cron ?? "one-off",
                timezone: s.timezone ?? "UTC",
                prompt: s.prompt,
                enabled: s.enabled,
                nextRunAt: new Date(s.nextRunAt).toISOString(),
              })),
          };
        },
      }),

      delete_agent_schedule: tool({
        description:
          "Delete one of the user's scheduled runs by id (from list_agent_schedules). " +
          "Pauses for the user's approval.",
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          // `unschedule` is owner-fenced and returns void, so a foreign or stale
          // id deletes nothing silently. Confirm it's the caller's first —
          // otherwise this reports a deletion that never happened.
          const mine = await runtime.listSchedules({ principal });
          if (!mine.some((s) => s.id === id)) {
            return { error: `No schedule ${id} — call list_agent_schedules for current ids.` };
          }
          await runtime.unschedule({ principal, id });
          return { deleted: id };
        },
      }),
    };
  },
};
