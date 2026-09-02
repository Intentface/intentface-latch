import type { AuthResult } from "@intentface/latch-channels";
import { isOrgMember } from "./auth";
import { baseUrl } from "./base-url";
import { buildChannelLinkUrl } from "./channel-link";
import type { ChannelBot, ChannelStore } from "./channel-store";
import type { DmChannelKind } from "./channel-kinds";
import type { Principal } from "./session";

/**
 * Who may drive (or be pushed to by) a DM bot — the one rule, used at both ends:
 * inbound webhooks (`authorizeUser`) and outbound scheduled delivery
 * (`resolveDelivery`). Both mint a principal for a Latch user against a bot
 * binding, and both have to re-check what the identity row can't know:
 *
 *  - identity rows outlive org membership — a removed member must not keep
 *    channel access to org agents (or keep receiving their output);
 *  - a personal-agent binding resolves the CREATOR's record — any other member
 *    would resolve their own same-named agent, or nothing.
 *
 * Returns the refusal message, or null when the user may proceed.
 */
export async function refusalForLinkedUser(
  bot: Pick<ChannelBot, "orgId" | "agentScope" | "userId">,
  userId: string,
): Promise<string | null> {
  if (!(await isOrgMember(userId, bot.orgId))) {
    return "Your Latch account is no longer a member of this agent's organization.";
  }
  if (bot.agentScope === "user" && bot.userId !== userId) {
    return "This bot serves a personal agent — only its owner can use it.";
  }
  return null;
}

/**
 * The inbound identity gate for a DM bot: resolve the platform user's link,
 * apply the rule above, and on an unlinked user hand back a signed link (the
 * kernel stashes their message for replay after linking). `meta` rides along
 * in the link for the confirmation page (a Telegram @username).
 */
export function dmIdentityGate(opts: { kind: DmChannelKind; bot: ChannelBot; channelStore: ChannelStore }) {
  const { kind, bot, channelStore } = opts;
  return async (externalId: string, meta?: string): Promise<AuthResult<Principal>> => {
    const identity = await channelStore.resolveIdentity(kind, bot.id, externalId);
    if (identity) {
      const refusal = await refusalForLinkedUser(bot, identity.userId);
      if (refusal) return { allowed: false, message: refusal };
      return { allowed: true, principal: { orgId: bot.orgId, userId: identity.userId } };
    }
    return {
      allowed: false,
      message: "You need a Latch account to use this agent.",
      linkUrl: buildChannelLinkUrl(baseUrl(), {
        kind,
        botRef: bot.id,
        externalId,
        ...(meta ? { meta } : {}),
      }),
    };
  };
}
