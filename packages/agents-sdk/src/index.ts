/**
 * @intentface/agents-sdk — experimental.
 *
 * A tool-calling loop we own, plus an extension model where a feature is an
 * extension rather than a change to the runtime. Deliberately outside the
 * `@intentface/latch-*` version line, private, and free to break.
 *
 * The three ideas it is testing:
 *
 *  1. Runs end, they do not pause. A run that needs a human ends; the
 *     unanswered tool call in the transcript IS the suspended state, and
 *     resuming is a new run over a longer message list. No `awaiting` status.
 *  2. The stored `UIMessage[]` is the only durable thing. Everything else is
 *     recomputed per step, and three moments may change it.
 *  3. Extensions return effects, not rewritten worlds, so each moment's powers
 *     are enumerable and `compose` stays small.
 */

export { runAgentLoop, renderTranscript, type AgentLoopOptions, type BlockedToolOutput } from "./loop.js";
export { reconcile } from "./reconcile.js";
export {
  compaction,
  SUMMARY_PART,
  COMPACTED_PART,
  compactionPlan,
  lastSummaryIndex,
  type CompactionInfo,
  type CompactionOptions,
} from "./compaction.js";
export {
  truncateToolOutput,
  isTruncated,
  type TruncateOptions,
  type TruncatedOutput,
} from "./truncate.js";
export {
  costTracking,
  costOfStep,
  priceFor,
  type CostOptions,
  type ModelPrice,
  type Spend,
  type SpendReport,
} from "./cost.js";
export { compose, ExtensionFailedError, type ComposeOptions, type Composed } from "./compose.js";
export {
  defineExtension,
  isNewSession,
  dropChunks,
  listCommands,
  type API,
  type CommandOptions,
  type CommandReply,
  type ChunkEffect,
  type ContextEffect,
  type ContextOptions,
  type DefineOptions,
  type Extension,
  type Hooks,
  type InputEffect,
  type InstructionsEffect,
  type Part,
  type Principal,
  type RegisteredCommand,
  type StartEffect,
  type StepContext,
  type StepControlEffect,
  type StepEffect,
  type StepInfo,
  type StepUsage,
  type SteerEffect,
  type ToolCallEffect,
  type ToolResultEffect,
  type ViewEffect,
} from "./extension.js";
