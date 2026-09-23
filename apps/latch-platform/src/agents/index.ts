import { assistant } from "./assistant";
import { weekly } from "./weekly";
import { agentBuilder } from "./agent-builder";
import { evalAuthor } from "./eval-author";
import { evalsAgent } from "./evals";
import { anchorInterview } from "./anchor-interview";
import { anchorInterviewMem } from "./anchor-interview-mem";
import { anchorOrient } from "./anchor-orient";
import { anchorSession } from "./anchor-session";
import { anchorMaintainer } from "./anchor-maintainer";
import { anchorFrameKeeper } from "./anchor-frame-keeper";
import { edgeOnboarding } from "./edge-onboarding";
import { edgeAdvisor } from "./edge-advisor";
import { clientWorkInterview } from "./anchor-client-work-interview";
import { memoryExtractor } from "./memory-extractor";
import { memoryConsolidator } from "./memory-consolidator";

/**
 * The platform's agents, keyed by name. Each agent file is a self-contained
 * declarative def (including the connections it may use); add a file under
 * `agents/` and register it here. Names + metadata flow to the UI picker via
 * `runtime.listAgents()`.
 */
export const agents = {
  assistant,
  weekly,
  "agent-builder": agentBuilder,
  "eval-author": evalAuthor,
  evals: evalsAgent,
  "anchor-interview": anchorInterview,
  "anchor-interview-mem": anchorInterviewMem,
  "anchor-orient": anchorOrient,
  "client-work-interview": clientWorkInterview,
  "anchor-session": anchorSession,
  "anchor-maintainer": anchorMaintainer,
  "anchor-frame-keeper": anchorFrameKeeper,
  "edge-onboarding": edgeOnboarding,
  "edge-advisor": edgeAdvisor,
  // System agents spawned by the memory sweep (filtered from user-facing
  // pickers by the `memory-` prefix).
  "memory-extractor": memoryExtractor,
  "memory-consolidator": memoryConsolidator,
};
