/**
 * The extension seam: moments, effects, the composer, and the tool wiring.
 *
 * `RuntimeConfig.extensions` and `AgentConfig.extensions` take `Extension[]`.
 * Omit both and the runtime behaves exactly as before — every moment is a
 * no-op with no handlers attached.
 */
export * from "./extension.js";
export * from "./compose.js";
export * from "./tools.js";
