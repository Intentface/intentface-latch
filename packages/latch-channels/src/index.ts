/**
 * @intentface/latch-channels
 *
 * Bring a Latch agent to the places people talk — Slack first. The generic
 * core here is platform-agnostic and dependency-light: a run→`RenderEvent`
 * projection (`consumeRun`) and approval detection (`pendingApprovals`) over
 * the runtime's public SSE contract. Per-platform adapters live in subpath
 * exports (e.g. `@intentface/latch-channels/slack`) and only ever translate
 * `RenderEvent`s — they never re-parse the AI stream.
 *
 * Identity (which platform user maps to which Principal) and channel→agent
 * binding stay in user-land, per Latch's isolation model.
 */
export * from "./types.js";
export * from "./render.js";
export * from "./ask.js";
export * from "./commands.js";
export * from "./kernel.js";
