/**
 * The agent editor's defaultTools serialization, extracted pure so the
 * preserve-vs-expand rules are unit-testable.
 *
 * `defaultTools` on an agent is `true` (the whole app-tool set), a name list,
 * or absent. The editor edits it through capability toggles and always saves
 * an explicit name list (never bare `true`) to keep the grant least-privilege.
 */

/**
 * The schedule capability = the four schedule tools together: `create_schedule`
 * depends on `list_delivery_channels` for targets, and `list_schedules` /
 * `cancel_schedule` let the user manage what create made. Granting them
 * piecemeal would leave the model with half a workflow.
 */
export const SCHEDULE_TOOLS: string[] = [
  "list_delivery_channels",
  "create_schedule",
  "list_schedules",
  "cancel_schedule",
];

/**
 * Every defaultTools name the editor owns a toggle for. Anything an agent has
 * beyond these (a future default tool added server-side) is preserved on save.
 */
export const KNOWN_DEFAULT_TOOLS: string[] = ["web_fetch", "askUser", ...SCHEDULE_TOOLS];

/** Whether the agent's stored `defaultTools` grants the named tool. */
export function hasDefaultTool(prev: boolean | string[] | undefined, name: string): boolean {
  return prev === true || (Array.isArray(prev) && prev.includes(name));
}

/**
 * Build the explicit defaultTools list to save from the editor's toggles.
 *
 * Rules:
 * - Each toggle contributes its names; `render_fetch` never (it's the separate
 *   `renderTools` capability, like sandbox).
 * - Names beyond KNOWN_DEFAULT_TOOLS are preserved verbatim.
 * - Schedules: a stored PARTIAL subset (possible via the API or agent-builder)
 *   is preserved exactly on an untouched save — expanding it to all four on a
 *   no-op save would silently grant `create_schedule`. Only an explicit change
 *   to the Schedules toggle (`schedulesTouched`) replaces the subset with the
 *   full capability.
 * - `prev === true` reads as the full known set, so it round-trips explicit.
 */
export function buildDefaultTools(opts: {
  webTools: boolean;
  askUser: boolean;
  schedules: boolean;
  schedulesTouched: boolean;
  prev: boolean | string[] | undefined;
}): string[] | undefined {
  const prevList = opts.prev === true ? KNOWN_DEFAULT_TOOLS : Array.isArray(opts.prev) ? opts.prev : [];
  const prevSchedule = prevList.filter((n) => SCHEDULE_TOOLS.includes(n));
  const preserved = prevList.filter(
    (n) => !KNOWN_DEFAULT_TOOLS.includes(n) && n !== "render_fetch",
  );
  const schedule = opts.schedules
    ? opts.schedulesTouched || prevSchedule.length === 0
      ? SCHEDULE_TOOLS
      : prevSchedule
    : [];
  const names = [
    ...(opts.webTools ? ["web_fetch"] : []),
    ...(opts.askUser ? ["askUser"] : []),
    ...schedule,
    ...preserved,
  ];
  return names.length ? [...new Set(names)] : undefined;
}
