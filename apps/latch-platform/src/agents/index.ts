import { assistant } from "./assistant";

/**
 * The platform's agents, keyed by name. Each agent file is a self-contained
 * declarative def (including the connections it may use); add a file under
 * `agents/` and register it here.
 */
export const agents = {
  assistant,
};
