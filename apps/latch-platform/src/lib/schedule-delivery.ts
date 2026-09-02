import { slackApi } from "@intentface/latch-channels/slack";
import { telegramChatId } from "@intentface/latch-channels/telegram";
import type { ScheduleRecord } from "@intentface/latch-core";
import { getLatch } from "./latch";
import { isOrgMember } from "./auth";
import { parseAgentRef } from "./agent-store";
import { getTelegramChannelForBot } from "./telegram-channel";
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
  | { kind: "telegram"; botId: string }
  | { kind: "slack"; appId: string; channel: string };

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
 * a row per channel, a Telegram bot is one row (the DM is implied and derived).
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
    c.kind === "telegram"
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
  if (v.kind === "telegram" && typeof v.botId === "string") {
    return { kind: "telegram", botId: v.botId };
  }
  if (v.kind === "slack" && typeof v.appId === "string" && typeof v.channel === "string") {
    return { kind: "slack", appId: v.appId, channel: v.channel };
  }
  return null;
}

/**
 * The delivery targets `principal` may point a schedule for `agent` at.
 *
 * Telegram: the org's active bots bound to this agent that the caller has
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

  for (const bot of await channelStore.botsForAgent("telegram", principal.orgId, agent)) {
    if (bot.agentScope === "user" && bot.userId !== principal.userId) continue;
    if (!principal.userId) continue;
    const identity = await channelStore.identityForUser("telegram", bot.id, principal.userId);
    if (!identity) continue;
    out.push({
      kind: "telegram",
      ref: bot.id,
      label: bot.externalHandle ? `@${bot.externalHandle}` : (bot.displayName ?? bot.handle),
    });
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
    // A stray `channel` on a Telegram target is ignored rather than fatal: the
    // DM is derived from the identity row, so there is nothing for it to select.
    (o) =>
      o.kind === want.kind &&
      o.ref === want.ref &&
      (o.kind !== "slack" || o.channel === want.channel),
  );
  if (!offered) return null;
  const delivery: ScheduleDelivery =
    offered.kind === "telegram"
      ? { kind: "telegram", botId: offered.ref }
      : { kind: "slack", appId: offered.ref, channel: offered.channel! };
  await resolveDelivery(principal, agentRef, delivery);
  return { delivery, label: offered.label };
}

/** A validated Telegram target: the bot plus the DM it resolves to. */
interface TelegramTarget {
  kind: "telegram";
  botId: string;
  telegramUserId: string;
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
 * Every check that inbound webhook turns make is repeated here in the same
 * order (`telegram-channel.ts` `authorizeUser`), because this path mints a
 * conversation from our side with no user action to imply consent.
 */
export async function resolveDelivery(
  principal: Principal,
  agentRef: string,
  delivery: ScheduleDelivery,
): Promise<TelegramTarget | SlackTarget> {
  const { channelStore, slackStore } = await getLatch();
  if (!principal.userId) {
    throw new DeliveryError("Channel delivery needs a user-scoped principal.");
  }
  // Bindings store the bare name; schedules and runs may carry a scope pin.
  const agent = parseAgentRef(agentRef).name;

  if (delivery.kind === "telegram") {
    const bot = await channelStore.getBot("telegram", delivery.botId);
    if (!bot || bot.status !== "active") throw new DeliveryError("That bot isn't active.");
    if (bot.orgId !== principal.orgId) throw new DeliveryError("That bot isn't in your org.");
    // A bot serves exactly one agent, and `latch_chats` rows carry an agent —
    // delivering agent A into agent B's DM would write A's turns into a
    // conversation that belongs to B.
    if (bot.agent !== agent) {
      throw new DeliveryError(`That bot serves "${bot.agent}", not "${agent}".`);
    }
    if (bot.agentScope === "user" && bot.userId !== principal.userId) {
      throw new DeliveryError("That bot serves a personal agent — only its owner can use it.");
    }
    const identity = await channelStore.identityForUser("telegram", bot.id, principal.userId);
    if (!identity) throw new DeliveryError("You haven't linked your Telegram account to that bot.");
    // Identity rows outlive org membership — revalidate, or a removed member
    // keeps receiving the org's agent output.
    if (!(await isOrgMember(principal.userId, bot.orgId))) {
      throw new DeliveryError("You're no longer a member of that agent's organization.");
    }
    // The DM is derived from the identity row, never from the schedule — a
    // stored chat id would be a confused-deputy waiting to happen.
    return { kind: "telegram", botId: bot.id, telegramUserId: identity.externalId };
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

  let target: TelegramTarget | SlackTarget;
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

  return target.kind === "telegram"
    ? runTelegramDelivery(schedule, principal, target)
    : runSlackDelivery(schedule, principal, target);
}

/**
 * Telegram: run the schedule's prompt in the user's REAL DM thread, so the
 * report arrives in the conversation they reply into and a follow-up has the
 * brief in context. `runMessage` streams it in and renders any approvals or
 * questionnaires the turn parks on — a cron fire becomes as interactive as a
 * typed message.
 */
async function runTelegramDelivery(
  schedule: ScheduleRecord,
  principal: Principal,
  target: TelegramTarget,
): Promise<boolean> {
  const { channelStore } = await getLatch();
  const resolved = await getTelegramChannelForBot(target.botId);
  if (!resolved) return false;

  // The thread the DM is currently on (`/new` bumps the epoch). The id format
  // is the adapter's, so build it with the adapter's helper rather than
  // restating it here. A store failure propagates instead of falling back to
  // epoch 0 — that would write into the conversation the user just left behind.
  const base = telegramChatId(target.botId, target.telegramUserId);
  const epoch = await channelStore.currentThread(base);
  const chatId = telegramChatId(target.botId, target.telegramUserId, epoch);

  // One turn per chat. A held lease means the person is mid-conversation right
  // now; skip this occurrence rather than interleaving two runs on one history
  // (`runDue` advances `nextRunAt` regardless, so the schedule stays healthy).
  const token = await channelStore.claimTurn(chatId);
  if (!token) {
    console.warn(`[schedule] ${schedule.id}: telegram DM busy — skipping this fire`);
    return true;
  }
  try {
    await resolved.channel.runMessage({
      chatId,
      principal,
      // In a private chat Telegram's chat_id IS the user id.
      telegramChatId: target.telegramUserId,
      telegramUserId: target.telegramUserId,
      text: schedule.prompt,
    });
    return true;
  } finally {
    await channelStore.releaseTurn(chatId, token).catch(() => {});
  }
}

/**
 * Slack: post an anchor message, then run the turn threaded under it. A Latch
 * chat is anchored to a thread root, so there is no standing conversation to
 * continue the way a Telegram DM is — every fire gets its own thread, which is
 * also the Slack-native shape for a recurring brief (and means no turn lease is
 * needed: two fires can never share a history).
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
  const anchor = await api.postMessage({
    channel: target.channel,
    text: `:alarm_clock: ${summarize(schedule.prompt)}`,
  });

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
