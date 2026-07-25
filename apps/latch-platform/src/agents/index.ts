import { assistant } from "./assistant";
import { weekly } from "./weekly";
import { agentBuilder } from "./agent-builder";
import { evalAuthor } from "./eval-author";
import { anchorInterview } from "./anchor-interview";
import { anchorOrient } from "./anchor-orient";
import { anchorSession } from "./anchor-session";
import { anchorMaintainer } from "./anchor-maintainer";
import { anchorFrameKeeper } from "./anchor-frame-keeper";
import { edgeOnboarding } from "./edge-onboarding";
import { edgeAdvisor } from "./edge-advisor";
import { clientWorkInterview } from "./anchor-client-work-interview";
import { runningCoach } from "./running-coach";
import { runningCoachMemoryWriter } from "./running-coach-memory-writer";

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
  "anchor-interview": anchorInterview,
  "anchor-orient": anchorOrient,
  "client-work-interview": clientWorkInterview,
  "anchor-session": anchorSession,
  "anchor-maintainer": anchorMaintainer,
  "anchor-frame-keeper": anchorFrameKeeper,
  "edge-onboarding": edgeOnboarding,
  "edge-advisor": edgeAdvisor,
  "running-coach": runningCoach,
  "running-coach-memory-writer": runningCoachMemoryWriter,
};
