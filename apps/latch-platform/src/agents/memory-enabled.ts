import type { MemoryConfig } from "@intentface/latch-core";
import { anchorInterviewMemMemory } from "./anchor-interview-mem";

/**
 * Code agents with memory enabled — the sweep's discovery registry for
 * built-ins (agent factories are per-principal, so they can't be introspected
 * without a caller).
 *
 * RULE: an agent file that enables memory exports ONE MemoryConfig constant,
 * sets it as `memory` in its returned AgentConfig, AND registers it here under
 * its registry key — a single constant read from both places, so this
 * side-registry can't drift from what the factory returns.
 *
 * UI-created agents don't live here — the sweep discovers them via
 * `agentStore.listMemoryEnabledNames()` (the `exec.memory` field).
 */
export const memoryEnabledCodeAgents: Record<string, MemoryConfig> = {
  // e.g. "running-coach": runningCoachMemory,
  "anchor-interview-mem": anchorInterviewMemMemory,
};
