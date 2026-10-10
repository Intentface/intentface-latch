import { slackApi } from "@intentface/latch-channels/slack";
import type { ScheduleRecord } from "@intentface/latch-core";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { parseAgentRef } from "./agent-store";
import { refusalForLinkedUser } from "./channel-auth";
import type { DmChannelKind } from "./channel-kinds";
import { getTelegramChannelForBot } from "./telegram-channel";
import { getWhatsappChannelForBot } from "./whatsapp-channel";
import { getSlackChannelForApp } from "./slack-channel";
import { slackVaultKeys } from "./slack-store";
import type { Principal } from "./session";

/**
 * Where a scheduled run's output goes.
 *
 * By default `runDue` fires a schedule into a brand-new chat and the answer
 * only ever surfaces in the web chat list — fine for a background job, useless
 * for a briefing you actually want to read. A schedule may instead carry a
 * `delivery` target, and then the fire runs IN the channel conversation, so the
 * report lands where the person already is and stays repliable.
 *
 * Core knows none of this: `ScheduleRecord.delivery` is opaque there, and this
 * module is wired in as `createRuntime({ runSchedule })`.
 *
 * Two shapes of target. A DM bot (Telegram, WhatsApp) delivers into the user's
 * own conversation with that bot — the DM is derived from their identity row,
 * never stored. A Slack app delivers into a channel, each fire as its own
 * thread.
 *
 * ── The authorization rule ────────────────────────────────────────────────
 * `resolveDelivery` is the single gate, called at BOTH ends:
 *   • create time, so a bad target fails immediately with a clear message;
 *   • fire time, because it is the only check that can be trusted — bots get
 *     disabled, members get removed and links get broken in between.
 * A fire whose entitlement has lapsed falls back to the ordinary fresh-chat run
 * (see `runScheduledDelivery`): the work still happens, but nothing is pushed
 * to a conversation the principal no longer owns.
 */
export type ScheduleDelivery =
  | { kind: DmChannelKind; botId: string }
  | { kind: "slack"; appId: string; channel: string };

const DM_KINDS: readonly DmChannelKind[] = ["telegram", "whatsapp"];
const isDmKind = (k: unknown): k is DmChannelKind => DM_KINDS.includes(k as DmChannelKind);

/** A delivery target offered to a picker (UI select, builder discovery tool). */
export interface AgentChannel {
  kind: ScheduleDelivery["kind"];
  /** The stable id this target is stored as (`botId` / `appId`). */
  ref: string;
  /** Human label, e.g. `@briefbot` or `Weekly Brief (Slack)`. */
  label: string;
  /** Slack only: the channels the bot can post into. */
  channels?: { id: string; name: string }[];
}

/**
 * One postable target, as a model or a select sees it: a Slack app fans out into
 * a row per channel, a DM bot is one row (the DM is implied and derived).
 */
export interface DeliveryOption {
  kind: ScheduleDelivery["kind"];
  ref: string;
  /** Slack only. */
  channel?: string;
  label: string;
}

/** What a discovery tool hands the model, and what a target is matched against. */
export function deliveryOptions(available: AgentChannel[]): DeliveryOption[] {
  return available.flatMap<DeliveryOption>((c) =>
    c.kind !== "slack"
      ? [{ kind: c.kind, ref: c.ref, label: c.label }]
      : (c.channels ?? []).map((ch) => ({
          kind: c.kind,
          ref: c.ref,
          channel: ch.id,
          label: `#${ch.name}`,
        })),
  );
}

export class DeliveryError extends Error {}

/** Narrow unknown JSON (a DB column, a tool argument) to a delivery target. */
export function parseScheduleDelivery(value: unknown): ScheduleDelivery | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (isDmKind(v.kind) && typeof v.botId === "string") return { kind: v.kind, botId: v.botId };
  if (v.kind === "slack" && typeof v.appId === "string" && typeof v.channel === "string") {
    return { kind: "slack", appId: v.appId, channel: v.channel };
  }
  return null;
}

/**
 * The delivery targets `principal` may point a schedule for `agent` at.
 *
 * DM bots: the org's active bots bound to this agent that the caller has
 * personally linked — an unlinked bot has no DM to push into, and offering it
 * would only produce a create-time error. Slack: apps bound to this agent that
 * the caller OWNS (see the principal note in `runSlackDelivery`), each with its
 * public channels.
 */
export async function listAgentChannels(
  principal: Principal,
  agentRef: string,
): Promise<AgentChannel[]> {
  const { channelStore, slackStore, credentials } = await getLatch();
  const out: AgentChannel[] = [];
  // Bindings store the bare agent name; a caller may hand us a scope-pinned ref
  // (that's what `latch_runs.agent` holds).
  const agent = parseAgentRef(agentRef).name;

  for (const kind of DM_KINDS) {
    for (const bot of await channelStore.botsForAgent(kind, principal.orgId, agent)) {
      if (bot.agentScope === "user" && bot.userId !== principal.userId) continue;
      if (!principal.userId) continue;
      const identity = await channelStore.identityForUser(kind, bot.id, principal.userId);
      if (!identity) continue;
      out.push({
        kind,
        ref: bot.id,
        label:
          kind === "telegram" && bot.externalHandle
            ? `@${bot.externalHandle}`
            : (bot.displayName ?? bot.handle),
      });
    }
  }

  for (const app of await slackStore.appsForAgent(principal.orgId, agent)) {
    if (app.userId !== principal.userId) continue;
    let channels: { id: string; name: string }[] = [];
    try {
      const token = await credentials.get(
        { orgId: app.orgId, userId: app.userId },
        slackVaultKeys(app.appId).botToken,
        "org",
      );
      // Best-effort: a missing token or scope shouldn't hide the app entirely —
      // a channel id can still be typed in by hand.
      if (token) channels = await slackApi(token).conversationsList();
    } catch (e) {
      console.warn(`[schedule] slack channel list failed for ${app.appId}:`, e);
    }
    out.push({
      kind: "slack",
      ref: app.appId,
      label: app.botName ?? app.appId,
      channels,
    });
  }

  return out;
}

/**
 * Validate a target a MODEL supplied (the builder's `deliverTo`, the harness
 * `deliver_to`) against what the caller may actually reach.
 *
 * Two failure modes, kept distinct because they mean different things to the
 * model: `null` means the target wasn't offered by discovery — a hallucinated or
 * stale ref, the caller should list again; a thrown `DeliveryError` means the
 * target is real but the entitlement doesn't hold, which is the same message the
 * fire would produce. Offered targets are still put through `resolveDelivery`,
 * so discovery is a filter and never the authority.
 *
 * Returns the stored shape plus the label discovery used, so a tool can echo
 * "@briefbot" back rather than just "telegram".
 */
export async function resolveOfferedDelivery(
  principal: Principal,
  agentRef: string,
  want: { kind: string; ref: string; channel?: string },
): Promise<{ delivery: ScheduleDelivery; label: string } | null> {
  const offered = deliveryOptions(await listAgentChannels(principal, agentRef)).find(
    // A stray `channel` on a DM target is ignored rather than fatal: the DM is
    // derived from the identity row, so there is nothing for it to select.
    (o) =>
      o.kind === want.kind &&
      o.ref === want.ref &&
      (o.kind !== "slack" || o.channel === want.channel),
  );
  if (!offered) return null;
  const delivery: ScheduleDelivery =
    offered.kind !== "slack"
      ? { kind: offered.kind, botId: offered.ref }
      : { kind: "slack", appId: offered.ref, channel: offered.channel! };
  await resolveDelivery(principal, agentRef, delivery);
  return { delivery, label: offered.label };
}

/** A validated DM target: the bot plus the platform user whose DM it resolves to. */
interface DmTarget {
  kind: DmChannelKind;
  botId: string;
  externalId: string;
}

interface SlackTarget {
  kind: "slack";
  appId: string;
  channel: string;
  /** The app owner — the principal Slack turns run as. */
  ownerUserId: string;
}

/**
 * Validate a delivery target for (principal, agent), or throw `DeliveryError`.
 *
 * Every check that inbound webhook turns make is repeated here (the shared
 * `refusalForLinkedUser` rule), because this path mints a conversation from our
 * side with no user action to imply consent.
 */
export async function resolveDelivery(
  principal: Principal,
  agentRef: string,
  delivery: ScheduleDelivery,
): Promise<DmTarget | SlackTarget> {
  const { channelStore, slackStore } = await getLatch();
  if (!principal.userId) {
    throw new DeliveryError("Channel delivery needs a user-scoped principal.");
  }
  // Bindings store the bare name; schedules and runs may carry a scope pin.
  const agent = parseAgentRef(agentRef).name;

  if (delivery.kind !== "slack") {
    const bot = await channelStore.getBot(delivery.kind, delivery.botId);
    if (!bot || bot.status !== "active") throw new DeliveryError("That bot isn't active.");
    if (bot.orgId !== principal.orgId) throw new DeliveryError("That bot isn't in your org.");
    // A bot serves exactly one agent, and `latch_chats` rows carry an agent —
    // delivering agent A into agent B's DM would write A's turns into a
    // conversation that belongs to B.
    if (bot.agent !== agent) {
      throw new DeliveryError(`That bot serves "${bot.agent}", not "${agent}".`);
    }
    const identity = await channelStore.identityForUser(delivery.kind, bot.id, principal.userId);
    const refusal = await refusalForLinkedUser(bot, principal.userId);
    if (refusal) throw new DeliveryError(refusal);
    if (!identity) throw new DeliveryError("You haven't linked your account to that bot.");
    // The DM is derived from the identity row, never from the schedule — a
    // stored chat id would be a confused-deputy waiting to happen.
    return { kind: delivery.kind, botId: bot.id, externalId: identity.externalId };
  }

  const app = await slackStore.resolve(delivery.appId);
  if (!app) throw new DeliveryError("That Slack app isn't registered.");
  if (app.orgId !== principal.orgId) throw new DeliveryError("That Slack app isn't in your org.");
  if (app.agent !== agent) {
    throw new DeliveryError(`That Slack app serves "${app.agent}", not "${agent}".`);
  }
  // Slack turns run as the app OWNER (slack-channel.ts), and chats are
  // owner-scoped: a fire running as anyone else would create a thread that
  // in-thread replies — which do run as the owner — could not read.
  if (!app.userId || app.userId !== principal.userId) {
    throw new DeliveryError("Only the Slack app's owner can schedule into it.");
  }
  if (!(await isOrgMember(principal.userId, app.orgId))) {
    throw new DeliveryError("You're no longer a member of that agent's organization.");
  }
  if (!delivery.channel) throw new DeliveryError("Pick a Slack channel to post into.");
  return {
    kind: "slack",
    appId: app.appId,
    channel: delivery.channel,
    ownerUserId: app.userId,
  };
}

/** First line of the prompt, for anchors and titles. */
const summarize = (prompt: string, max = 80) => {
  const line = prompt.split("\n").find((l) => l.trim()) ?? prompt;
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Fire-time identity re-validation. A schedule's principal is a snapshot
 * pinned at creation; the human behind it may have left the org since. When
 * the acting user is no longer a member, remove the schedule (via the
 * caller-supplied `unschedule` — owner-fenced, the fired principal IS the
 * schedule's) and return true: the fire is handled (suppressed), never run
 * as a departed member. The delivery legs below re-check membership per
 * fire already; this guards the default fresh-chat path too.
 */
export async function removeIfActorDeparted(
  input: { schedule: ScheduleRecord; principal: Principal },
  unschedule: (args: { principal: Principal; id: string }) => Promise<void>,
): Promise<boolean> {
  const { schedule, principal } = input;
  const actor = principal.actorUserId ?? principal.userId;
  if (!actor || (await isOrgMember(actor, principal.orgId))) return false;
  console.warn(
    `[schedule] ${schedule.id} (agent ${schedule.agent}): user ${actor} is no ` +
      `longer a member of ${principal.orgId} — removing schedule`,
  );
  await unschedule({ principal, id: schedule.id });
  return true;
}

/**
 * `createRuntime({ runSchedule })`: run this fire in its delivery channel.
 *
 * Returns false for "not handled" — no target, an invalid one, or an
 * entitlement that has lapsed — and core then runs the schedule its ordinary
 * way. Only a genuinely delivered (or deliberately skipped) fire returns true.
 */
export async function runScheduledDelivery(input: {
  schedule: ScheduleRecord;
  principal: Principal;
}): Promise<boolean> {
  const { schedule, principal } = input;
  const delivery = parseScheduleDelivery(schedule.delivery);
  if (!delivery) return false;

  let target: DmTarget | SlackTarget;
  try {
    target = await resolveDelivery(principal, schedule.agent, delivery);
  } catch (e) {
    // Not an error to shout about: the schedule outlived its target. Fall back
    // so the run still happens, just without the push.
    console.warn(
      `[schedule] ${schedule.id}: delivery no longer authorized (${
        e instanceof Error ? e.message : String(e)
      }) — running in a fresh chat instead`,
    );
    return false;
  }

  return target.kind === "slack"
    ? runSlackDelivery(schedule, principal, target)
    : runDmDelivery(schedule, principal, target);
}

/**
 * How to push into each DM channel: build the channel for the bot and replay
 * one message as that user. `replayMessage` is the kernel's post-link entry —
 * it resolves the user's current thread (`/new`), takes the one-turn-per-chat
 * lease, renders the answer and whatever the turn parks on. A held lease means
 * the person is mid-conversation right now; the kernel tells them it's still
 * working and this occurrence is skipped (`runDue` advanced `nextRunAt` already).
 */
const DM_DELIVERY: Record<
  DmChannelKind,
  (botId: string, externalId: string, text: string, principal: Principal) => Promise<boolean>
> = {
  telegram: async (botId, telegramUserId, text, principal) => {
    const resolved = await getTelegramChannelForBot(botId);
    if (!resolved) return false;
    // In a private chat Telegram's chat_id IS the user id.
    await resolved.channel.replayMessage({ telegramUserId, telegramChatId: telegramUserId, text, principal });
    return true;
  },
  whatsapp: async (botId, waId, text, principal) => {
    const resolved = await getWhatsappChannelForBot(botId);
    if (!resolved) return false;
    await resolved.channel.replayMessage({ waId, text, principal });
    return true;
  },
};

/**
 * DM bots: run the schedule's prompt in the user's REAL conversation with the
 * bot, so the report arrives where they reply and a follow-up has the brief in
 * context. Approvals and questionnaires the turn parks on render too — a cron
 * fire is as interactive as a typed message.
 */
async function runDmDelivery(
  schedule: ScheduleRecord,
  principal: Principal,
  target: DmTarget,
): Promise<boolean> {
  return DM_DELIVERY[target.kind](target.botId, target.externalId, schedule.prompt, principal);
}

/**
 * Slack: post an anchor message, then run the turn threaded under it. A Latch
 * chat is anchored to a thread root, so there is no standing conversation to
 * continue the way a DM is — every fire gets its own thread, which is also the
 * Slack-native shape for a recurring brief (and means no turn lease is needed:
 * two fires can never share a history).
 */
async function runSlackDelivery(
  schedule: ScheduleRecord,
  principal: Principal,
  target: SlackTarget,
): Promise<boolean> {
  const { credentials, channelStore } = await getLatch();
  const resolved = await getSlackChannelForApp(target.appId);
  if (!resolved) return false;
  if (resolved.app.status === "disabled") {
    console.warn(`[schedule] ${schedule.id}: binding ${target.appId} is disabled — skipping`);
    return false;
  }

  const token = await credentials.get(
    { orgId: principal.orgId, userId: target.ownerUserId },
    slackVaultKeys(target.appId).botToken,
    "org",
  );
  if (!token) {
    console.warn(`[schedule] ${schedule.id}: no Slack bot token for ${target.appId}`);
    return false;
  }

  const api = slackApi(token);
  // Nothing has run yet, so a failed post can still fall back to a chat. A
  // throw from here on would end the occurrence as an error instead (the turn
  // may have started), so this is the last point to decline.
  let anchor: Awaited<ReturnType<typeof api.postMessage>>;
  try {
    anchor = await api.postMessage({
      channel: target.channel,
      text: `:alarm_clock: ${summarize(schedule.prompt)}`,
    });
  } catch (e) {
    console.warn(`[schedule] ${schedule.id}: couldn't post to Slack; running it in a chat instead:`, e);
    return false;
  }

  // The adapter expects a SLACK user id: it becomes the thread's initiator
  // (who may drive follow-ups) and the target of ephemeral connect cards. The
  // schedule stores the LATCH owner — translate via their linked identity.
  // Unlinked owner → fall back to the raw id: the digest still posts, and
  // interactive follow-ups start working the moment they link.
  const ownerSlackId =
    (resolved.app.teamId
      ? (await channelStore.identityForUser("slack", resolved.app.teamId, target.ownerUserId))?.externalId
      : null) ?? target.ownerUserId;

  try {
    await resolved.channel.runMessage({
      channel: anchor.channel,
      root: anchor.ts,
      userId: ownerSlackId,
      prompt: schedule.prompt,
    });
  } catch (e) {
    // The anchor is already visible in the channel. If the turn couldn't start,
    // say so on it rather than leaving a bare ⏰ with no reply under it — an
    // empty thread reads as "still working" forever.
    await api
      .update({
        channel: anchor.channel,
        ts: anchor.ts,
        text: `:warning: ${summarize(schedule.prompt)} — scheduled run failed to start.`,
      })
      .catch((err) => console.error("[schedule] slack anchor cleanup failed:", err));
    throw e;
  }
  return true;
}
