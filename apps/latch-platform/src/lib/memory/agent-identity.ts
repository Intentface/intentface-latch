import { parseAgentRef } from "../agent-store";

/**
 * The MEMORY identity of an agent ref.
 *
 * Channel bindings pin agent resolution with an `org:`/`user:` prefix
 * (`telegram-channel.ts`, `slack-channel.ts`, `whatsapp-channel.ts`) so a
 * same-named personal agent can never shadow an org binding, and `latch_runs.agent`
 * keeps that pin verbatim. The pin is a credential-RESOLUTION hint, not a second
 * agent: `org:coach` and `coach` are the same coach and must share one memory.
 *
 * Nothing stripped it before scope derivation, and `seg()` does not pass `:`
 * through — it sanitizes and appends a hash of the raw name, so a channel-bound
 * agent silently got its own store (`_memory/org-coach-<hash>/u-…`) alongside the
 * web one. The agent could not recall on Telegram what it learned on the web.
 *
 * Apply this to every agent ref that reaches a scope derivation or the memory
 * job rows. `agentStore.getRecord`/`resolve` already parse the pin themselves;
 * without this, `memoryEnabledCodeAgents[ref]` also misses for a code agent
 * bound to a channel, which turns its memory off entirely.
 */
export const memoryAgentOf = (ref: string): string => parseAgentRef(ref).name;
