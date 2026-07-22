import { assistant } from "./assistant";
import { weekly } from "./weekly";
import { agentBuilder } from "./agent-builder";
import { evalAuthor } from "./eval-author";

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
};
