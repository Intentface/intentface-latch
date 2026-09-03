import type { AgentRecord, AgentRecordInput } from "@intentface/latch-agent-builder/record";

/**
 * The agent editor's pure half: the record IS the form state. The editor keeps
 * one `AgentRecord` in React state and patches it; everything that must stay
 * coherent across fields (memory ↔ connections/scope, effort ↔ model) lives in
 * `coerceRecord`, and the last-mile shaping for the wire lives in
 * `toSavePayload`. Nothing here touches React or the server, so the rules are
 * unit-testable and the editor component is mostly bindings.
 *
 * Editor-state conventions (differ from the STORED record in two places, both
 * undone by `toSavePayload` / the server's `normalizeAgentRecord`):
 *  - `exec.defaultTools` is always an explicit name list (`true` is expanded
 *    once on load), so the grant the user sees is the grant that saves.
 *  - `exec.memory.extractTo` holds the EXTRA levels only (the primary scope is
 *    implicit); the stored form is canonical `[primary, ...extras]`.
 */

export type { AgentRecord, AgentRecordInput };

export type MemoryLevel = NonNullable<NonNullable<AgentRecord["exec"]>["memory"]>["scope"];
export const MEMORY_LEVELS: MemoryLevel[] = ["agent-user", "agent-org", "user"];

/**
 * The schedule capability = the four schedule tools together: `create_schedule`
 * depends on `list_delivery_channels` for targets, and `list_schedules` /
 * `cancel_schedule` let the user manage what create made. Granting them
 * piecemeal would leave the model with half a workflow.
 */
export const SCHEDULE_TOOLS: readonly string[] = [
  "list_delivery_channels",
  "create_schedule",
  "list_schedules",
  "cancel_schedule",
];

/** Each editor toggle grants one group of `defaultTools` names. */
export const DEFAULT_TOOL_GROUPS = {
  web: ["web_fetch"],
  askUser: ["askUser"],
  schedules: SCHEDULE_TOOLS,
} as const satisfies Record<string, readonly string[]>;
export type DefaultToolGroup = keyof typeof DEFAULT_TOOL_GROUPS;

/** Every defaultTools name the editor owns a toggle for. Names beyond these are preserved on save. */
export const KNOWN_DEFAULT_TOOLS: readonly string[] = Object.values(DEFAULT_TOOL_GROUPS).flat();

/**
 * The stored `defaultTools` as an explicit list: `true` reads as the full known
 * set (so it round-trips explicit, least-privilege), `render_fetch` is never a
 * member (it is the separate `renderTools` capability, like sandbox).
 */
export function expandDefaultTools(v: boolean | string[] | undefined): string[] {
  const list = v === true ? KNOWN_DEFAULT_TOOLS : Array.isArray(v) ? v : [];
  return [...new Set(list.filter((n) => n !== "render_fetch"))];
}

/** Whether the list grants ANY of the group (a stored partial subset reads as "on"). */
export const groupOn = (list: readonly string[], group: DefaultToolGroup): boolean =>
  DEFAULT_TOOL_GROUPS[group].some((n) => list.includes(n));

/**
 * Toggle one group. Editing the list directly is what makes the preservation
 * rule fall out: an UNTOUCHED save keeps a stored partial subset byte-for-byte
 * (nothing rewrote it), an explicit "on" grants the full group, "off" removes
 * every member. Unknown names are never touched.
 */
export function toggleGroup(list: readonly string[], group: DefaultToolGroup, on: boolean): string[] {
  const members: readonly string[] = DEFAULT_TOOL_GROUPS[group];
  return on ? [...new Set([...list, ...members])] : list.filter((n) => !members.includes(n));
}

/** A fresh record for the "New agent" form. */
export function newAgentRecord(modelId: string): AgentRecord {
  return { name: "", modelId, instructions: "", connections: [], maxSteps: 20, scope: "user" };
}

/** A stored record in editor-state conventions (see the header). */
export function loadAgentRecord(stored: AgentRecord): AgentRecord {
  const exec = stored.exec ? { ...stored.exec } : undefined;
  if (exec) {
    exec.defaultTools = expandDefaultTools(exec.defaultTools);
    if (exec.memory) {
      const memory = { ...exec.memory };
      memory.extractTo = (memory.extractTo ?? []).filter((l) => l !== memory.scope);
      memory.schemas = { ...(memory.schemas ?? {}) };
      exec.memory = memory;
    }
  }
  return { ...stored, exec };
}

/**
 * Keep the record coherent after any edit. Pure and idempotent; the editor runs
 * it inside every `patch`, so no field can drift into a combination the server
 * would reject:
 *  - memory's connection must be one of the agent's connections — re-pick
 *    (loredex when declared, else the first) when it stops being one; when the
 *    agent has NO connections the pick is left as-is and the UI warns (the save
 *    payload drops memory then — see `toSavePayload`).
 *  - the org-shared level is only valid on org-visible agents — as the primary
 *    scope AND as an extraction level.
 *  - the primary scope never appears in the extras list.
 *  - effort only means something on a reasoning model.
 */
export function coerceRecord(rec: AgentRecord, ctx: { modelSupportsReasoning: boolean }): AgentRecord {
  let exec = rec.exec;
  if (exec?.memory) {
    const m = { ...exec.memory };
    if (rec.connections.length > 0 && !rec.connections.includes(m.connection)) {
      m.connection = rec.connections.includes("loredex") ? "loredex" : rec.connections[0];
    }
    if (rec.scope !== "org" && m.scope === "agent-org") m.scope = "agent-user";
    m.extractTo = (m.extractTo ?? []).filter(
      (l) => l !== m.scope && !(l === "agent-org" && rec.scope !== "org"),
    );
    exec = { ...exec, memory: m };
  }
  if (exec?.effort && !ctx.modelSupportsReasoning) exec = { ...exec, effort: undefined };
  return exec === rec.exec ? rec : { ...rec, exec };
}

export interface SaveContext {
  modelSupportsReasoning: boolean;
  /** Authored tools the agent may attach at its scope (org agents: org tools only). */
  visibleAuthored: readonly string[];
  /** The connections' tools as last listed — `tools` only saves when there are any. */
  toolList: readonly { name: string; description?: string }[];
}

/**
 * The record to send to `saveAgentFn`. Undoes the editor-state conventions
 * and drops what can't be saved: an invalid memory pick, authored tools the
 * scope can't see, a provider without a sandbox, description overrides that
 * merely repeat the tool's own text. Empty containers are left to the server's
 * `normalizeAgentRecord`.
 */
export function toSavePayload(rec: AgentRecord, ctx: SaveContext): AgentRecordInput {
  const exec = rec.exec ? { ...rec.exec } : undefined;
  if (exec) {
    exec.provider = exec.sandbox ? exec.provider : undefined;
    exec.sandbox = exec.sandbox || undefined;
    exec.renderTools = exec.renderTools || undefined;
    exec.providerWebTools = exec.providerWebTools || undefined;
    const defaults = expandDefaultTools(exec.defaultTools);
    exec.defaultTools = defaults.length ? defaults : undefined;
    const authored = (exec.authoredTools ?? []).filter((n) => ctx.visibleAuthored.includes(n));
    exec.authoredTools = authored.length ? authored : undefined;
    exec.effort = ctx.modelSupportsReasoning ? exec.effort : undefined;
    if (exec.memory) {
      const m = exec.memory;
      if (!m.connection || !rec.connections.includes(m.connection)) {
        exec.memory = undefined;
      } else {
        const extras = (m.extractTo ?? []).filter((l) => l !== m.scope);
        const active: MemoryLevel[] = [m.scope, ...extras];
        const schemas: NonNullable<typeof m.schemas> = {};
        for (const level of ["agent-user", "agent-org"] as const) {
          const text = m.schemas?.[level];
          if (active.includes(level) && text?.trim()) schemas[level] = text;
        }
        exec.memory = {
          scope: m.scope,
          connection: m.connection,
          extractTo: extras.length ? active : undefined,
          schemas: Object.keys(schemas).length ? schemas : undefined,
        };
      }
    }
  }
  let tools: AgentRecordInput["tools"];
  if (rec.tools && ctx.toolList.length > 0) {
    const allOn = ctx.toolList.every((t) => rec.tools!.enabled.includes(t.name));
    const descriptions: Record<string, string> = {};
    for (const t of ctx.toolList) {
      const v = rec.tools.descriptions?.[t.name];
      if (v != null && v.trim() && v.trim() !== (t.description ?? "").trim()) descriptions[t.name] = v.trim();
    }
    tools = {
      enabled: allOn ? [] : [...rec.tools.enabled],
      approval: rec.tools.approval,
      descriptions: Object.keys(descriptions).length ? descriptions : undefined,
    };
  }
  return {
    name: rec.name,
    title: rec.title || undefined,
    description: rec.description || undefined,
    modelId: rec.modelId,
    instructions: rec.instructions,
    connections: rec.connections,
    maxSteps: rec.maxSteps,
    tools,
    exec,
    subagents: rec.subagents?.length ? rec.subagents : undefined,
    scope: rec.scope,
  };
}
