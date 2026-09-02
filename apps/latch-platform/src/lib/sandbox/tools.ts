import { tool, jsonSchema } from "ai";
import { appTools as coreAppTools, harnessContextOf, sandboxTools } from "@intentface/latch-core/harness";
import { parseTelegramChatId } from "@intentface/latch-channels/telegram";
import { parseSlackChatId } from "@intentface/latch-channels/slack";
import { slackTools, slackToolsApproval } from "./slack-tools";
import { renderFetch, renderFetchConfigured } from "@/lib/render-fetch";
import { resolveDelivery, type ScheduleDelivery } from "@/lib/schedule-delivery";
import { checkScheduleLimits } from "@/lib/schedule-limits";
import type { Principal } from "@/lib/session";

/**
 * The platform's harness: the framework defaults (`@intentface/latch-core/harness`
 * — sandbox file/shell tools, web_fetch, askUser, list/cancel_schedule) plus
 * what is platform policy: `render_fetch` (needs the deployed render
 * service), delivery-aware self-scheduling (Telegram/Slack targets, the
 * schedule limits), and the Slack conversation tools.
 */

export { sandboxTools };

/**
 * The JS-page rung of the fetch ladder: renders the URL in a real headless
 * browser via the render service (packages/renderer). Sibling of web_fetch —
 * same guard, same app-process execution.
 */
const render_fetch = tool({
  description:
    "Fetch a URL in a real headless browser (JavaScript is executed) and " +
    "return the rendered visible text plus any schema.org JSON-LD (products, " +
    "prices, offers) and page links. Use when plain web_fetch returns a " +
    "JS-app shell, a cookie wall, an 'enable JavaScript' notice, or " +
    "navigation without the data. Slower and heavier than web_fetch — try " +
    "web_fetch first. Prefer the jsonLd in the result when present; it " +
    "carries exact structured data. For pages that need interaction before " +
    "the data appears (cookie wall, a tab to open, lazy content), drive it " +
    "with waitFor/clickSelector or an ordered `steps` script in the same " +
    "render pass.",
  inputSchema: jsonSchema<{
    url: string;
    include?: string;
    waitFor?: string;
    clickSelector?: string;
    steps?: {
      click?: string;
      waitFor?: string;
      scroll?: boolean;
      waitMs?: number;
    }[];
    scroll?: boolean;
  }>({
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-formed https URL to render." },
      include: {
        type: "string",
        description:
          'Comma-separated subset of: text, jsonLd, links, clickables, html. Default "text,jsonLd,links". Use "jsonLd" alone to save tokens when structured data suffices, "links" to discover subpages, "clickables" to see the buttons/inputs you can target in `steps`, "html" for raw markup.',
      },
      waitFor: {
        type: "string",
        description: "CSS selector to wait for before extracting (data that loads late).",
      },
      clickSelector: {
        type: "string",
        description: "CSS selector to click once before extracting (e.g. cookie-consent accept).",
      },
      steps: {
        type: "array",
        description:
          "Ordered actions run in the SINGLE render pass before extraction — for multi-step navigation (accept cookies → click a tab → scroll → read). Still one stateless render, not a live session. Use `include: \"clickables\"` first to discover selectors to target.",
        items: {
          type: "object",
          properties: {
            click: { type: "string", description: "CSS or text=Label selector to click." },
            waitFor: { type: "string", description: "Selector to wait for before continuing." },
            scroll: { type: "boolean", description: "Scroll to the bottom (lazy-loaded content)." },
            waitMs: { type: "number", description: "Fixed pause in ms (capped server-side)." },
          },
          additionalProperties: false,
        },
      },
      scroll: {
        type: "boolean",
        description: "Auto-scroll to the bottom once before extracting (triggers lazy content).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  execute: async (args) => renderFetch(args),
});

// ── Schedules ───────────────────────────────────────────────────────────────
// Let an agent set up its own recurring runs ("brief me every weekday at 8").
//
// Two things are deliberately NOT model-controlled:
//   • the agent — always the one the turn is running as, which keeps the
//     "a delivery bot serves exactly one agent" invariant true by construction;
//   • the delivery target — derived from the chat this turn is in, so a
//     prompt-injected agent cannot aim a recurring push at anyone else. In a
//     web chat there's no channel to derive, and the schedule is created
//     without delivery (it still shows up in the chat list and on /schedules).
//
// `create_schedule` is approval-gated by default (see `harnessTools.approval`),
// so in Telegram it surfaces as an Approve/Deny card before anything persists.

/**
 * The delivery target implied by the chat a turn is running in, or undefined
 * for a web chat. This is the whole reason the model never names a recipient:
 * a schedule created from a Telegram DM can only ever push back into THAT DM.
 *
 * Scoped Slack chat ids name the app outright; legacy ones don't, so for those
 * the app is recovered from the agent binding — and only when unambiguous.
 */
async function deliveryForChat(
  chatId: string,
  _principal: Principal,
  _agentRef: string,
): Promise<ScheduleDelivery | undefined> {
  const tg = parseTelegramChatId(chatId);
  if (tg) return { kind: "telegram", botId: tg.botRef };

  // v2 Slack chat ids name their app outright — no guessing, and it works for
  // an agent with several bots. v1 ids no longer parse (clean break): a chat
  // that predates the rewrite can't create scheduled deliveries; a new thread
  // can.
  const slack = parseSlackChatId(chatId);
  if (!slack) return undefined;
  return { kind: "slack", appId: slack.app, channel: slack.channel };
}

const ctxOf = (o: unknown) => harnessContextOf<Principal>(o);

const list_delivery_channels = tool({
  description:
    "Where a scheduled run of yours could be delivered: the Telegram bots the user " +
    "has linked to you, and the Slack channels they can post you into. Call this " +
    "when the user wants a schedule to reach them somewhere other than the chat " +
    "you're in right now (\"message me on Telegram every morning\"), then pass one " +
    "entry as create_schedule's `deliver_to` — invented refs are rejected.",
  inputSchema: jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  execute: async (_args, options) => {
    const { principal, run } = ctxOf(options);
    if (!principal || !run) return { error: "No principal for this turn." };
    const { listAgentChannels, deliveryOptions } = await import("@/lib/schedule-delivery");
    // Count the ENTRIES, not the apps: a Slack app whose channels couldn't be
    // listed yields none, and without the note the model gets an empty list and
    // no explanation for it.
    const channels = deliveryOptions(await listAgentChannels(principal, run.agent));
    return {
      channels,
      note:
        channels.length === 0
          ? "No channels available — a schedule will run in the app only. If the user expected " +
            "Telegram, they haven't linked this agent's bot yet."
          : undefined,
    };
  },
});

const create_schedule = tool({
  description:
    "Schedule yourself to run again later, on a cron expression (or omit `cron` " +
    "for a one-off on the next tick). Each fire starts a fresh turn with `prompt` " +
    "as the message. By default the result is delivered back into THIS " +
    "conversation's channel — in the web app that means nowhere, so if the user " +
    "wants to be reached (\"report to me on Telegram\") call " +
    "list_delivery_channels and pass an entry as `deliver_to`. Runs no more often " +
    "than every 15 minutes. The user confirms before anything is created.",
  inputSchema: jsonSchema<{
    cron?: string;
    timezone?: string;
    prompt: string;
    deliver_to?: { kind: "telegram" | "slack"; ref: string; channel?: string };
  }>({
    type: "object",
    properties: {
      cron: {
        type: "string",
        description: "5-field cron, e.g. `0 8 * * 1-5`. Omit for a one-off run.",
      },
      timezone: {
        type: "string",
        description: "IANA timezone the cron is read in, e.g. `Europe/Helsinki`. Defaults to UTC.",
      },
      prompt: {
        type: "string",
        description: "The message to send yourself each fire. Write it as an instruction.",
      },
      deliver_to: {
        type: "object",
        description:
          "Where each fire reports, from list_delivery_channels. Omit to use the " +
          "channel this conversation is already on.",
        properties: {
          kind: { type: "string", enum: ["telegram", "slack"] },
          ref: { type: "string", description: "The `ref` from list_delivery_channels." },
          channel: {
            type: "string",
            description: "Slack only: the `channel` from list_delivery_channels.",
          },
        },
        required: ["kind", "ref"],
        additionalProperties: false,
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { principal, run, runtime } = ctxOf(options);
    if (!principal || !run || !runtime) return { error: "No principal for this turn." };

    const cron = args.cron?.trim() || null;
    const rejected = await checkScheduleLimits(runtime, principal, cron, args.timezone);
    if (rejected) return { error: rejected };

    let delivery: ScheduleDelivery | undefined;
    let deliversTo: string;
    if (args.deliver_to) {
      // Model-supplied, so it must be one discovery offered — and an explicit
      // ask that can't be honoured is an error, never a silent downgrade to
      // app-only. The user sees this argument on the approval card.
      const { resolveOfferedDelivery, DeliveryError } = await import("@/lib/schedule-delivery");
      try {
        const offered = await resolveOfferedDelivery(principal, run.agent, args.deliver_to);
        if (!offered) {
          return {
            error:
              "That isn't one of your delivery channels. Call list_delivery_channels " +
              "and pass one of its entries.",
          };
        }
        delivery = offered.delivery;
        deliversTo = offered.label;
      } catch (e) {
        return { error: e instanceof DeliveryError ? e.message : "Delivery target rejected." };
      }
    } else {
      // Derived from the chat: re-checked through the same gate the fire uses, so
      // a target the caller isn't entitled to is dropped rather than stored (the
      // run still gets scheduled — the user asked for that part).
      delivery = await deliveryForChat(run.chatId, principal, run.agent);
      if (delivery) {
        try {
          await resolveDelivery(principal, run.agent, delivery);
        } catch (e) {
          console.warn("[create_schedule] derived delivery rejected:", e);
          delivery = undefined;
        }
      }
      deliversTo = delivery
        ? delivery.kind
        : "this app only — call list_delivery_channels if the user wanted to be messaged";
    }
    try {
      const created = await runtime.schedule({
        principal,
        agent: run.agent,
        cron,
        timezone: args.timezone,
        prompt: args.prompt,
        delivery,
      });
      return {
        id: created.id,
        cron: created.cron ?? "one-off",
        timezone: created.timezone ?? "UTC",
        nextRunAt: new Date(created.nextRunAt).toISOString(),
        deliversTo,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Failed to create the schedule." };
    }
  },
});

/** App-runtime default tools (granted by `defaultTools`; no sandbox needed). */
export const appTools = {
  // Framework defaults: web_fetch, askUser, list_schedules, cancel_schedule.
  ...coreAppTools,
  // Platform: delivery-aware self-scheduling.
  list_delivery_channels,
  create_schedule,
  // Slack conversation tools — self-refusing outside a Slack chat (the
  // authority derives from the run's chat id; see slack-tools.ts).
  ...slackTools,
} as Record<string, unknown>;
/**
 * Default gates for harness tools. Creating a schedule persists a recurring
 * side effect and — on a channel — a recurring push, so the user confirms it;
 * posting to another Slack channel publishes outside the conversation, ditto.
 * An agent may still override these in its own `toolApproval`.
 */
export const harnessApproval: Record<string, unknown> = {
  create_schedule: "user-approval",
  ...slackToolsApproval,
};
/**
 * Render tool(s) — a separate capability (agent flag `renderTools: true`), NOT
 * part of `defaultTools`, so `defaultTools: true` never sweeps it in. Present
 * only when the render service is configured, so agents never see a dead tool.
 */
export const renderTools = (
  renderFetchConfigured() ? { render_fetch } : {}
) as Record<string, unknown>;
