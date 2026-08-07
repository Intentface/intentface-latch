import type { AgentRecord } from "./store";

/**
 * The extension seam.
 *
 * The builder core is agent CRUD + discovery + test_agent. Anything beyond
 * that — evals, tool authoring, whatever a host grows next — plugs in here
 * instead of being compiled into the core, so hosts without the feature get a
 * builder that simply never mentions it. An extension contributes:
 *
 *  - tools:            merged into the builder's toolset (name-collision =
 *                      extension wins; keep names distinct).
 *  - promptSections:   appended verbatim to the builder's instructions.
 *  - subagents:        delegate agents (e.g. "eval-author"). Subagents run
 *                      autonomously; if the host auto-approves subagent tools
 *                      or the extension's flows must never mutate state, keep
 *                      the subagent READ-ONLY — persisting writes belong on
 *                      the builder where user approval gates them.
 *  - reservedNames:    agent names save_agent must refuse to overwrite.
 *  - toolApproval:     HITL policy for the extension's own tools.
 *  - validateSave:     veto a save_agent input (return an error string).
 *  - decorate*Result:  append guidance to save_agent / test_agent results —
 *                      the model acts on tool results far more reliably than
 *                      on distant prompt instructions (e.g. eval nudges).
 */

type MaybePromise<T> = T | Promise<T>;

/** The save_agent input slice extensions may validate (post-normalization). */
export interface SaveAgentInput {
  name: string;
  scope: AgentRecord["scope"];
  authoredTools?: string[];
  connections?: string[];
  subagents?: string[];
  modelId: string;
}

export interface AgentBuilderExtension<P> {
  /** Short id for diagnostics (e.g. "evals", "tool-authoring"). */
  name: string;
  /** Extra tools bound to the chatting user's principal. */
  tools?: (principal: P) => MaybePromise<Record<string, unknown>>;
  /** Instruction fragments appended to the builder's system prompt. */
  promptSections?: string[];
  /** Extra delegate agents (see read-only note above). */
  subagents?: string[];
  /** Agent names the builder must not overwrite (e.g. the extension's own subagents). */
  reservedNames?: string[];
  /** Per-tool approval policy for the extension's tools (merged into the builder's). */
  toolApproval?: Record<string, unknown>;
  /**
   * Declares that this extension understands `save_agent`'s `authoredTools`
   * field. Without any such extension the core REJECTS a non-empty
   * `authoredTools` (a clear error beats silently dropping capabilities).
   */
  handlesAuthoredTools?: boolean;
  /**
   * Veto a save: return an error string to reject (surfaced as the tool
   * result), or undefined to pass. Runs after the core validations.
   */
  validateSave?: (principal: P, input: SaveAgentInput, record: AgentRecord) => MaybePromise<string | undefined>;
  /** Amend the save_agent success result (e.g. append an eval nudge to `note`). */
  decorateSaveResult?: (
    principal: P,
    agentName: string,
    result: Record<string, unknown>,
  ) => MaybePromise<Record<string, unknown>>;
  /** Amend the test_agent result the same way. */
  decorateTestResult?: (
    principal: P,
    agentName: string,
    result: Record<string, unknown>,
  ) => MaybePromise<Record<string, unknown>>;
}
