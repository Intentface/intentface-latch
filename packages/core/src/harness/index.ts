/**
 * @intentface/latch-core/harness
 *
 * The default harness tools every host used to copy: sandbox file/shell tools,
 * `web_fetch`, `askUser`, and the schedule read/cancel tools. Pass
 * `harnessTools: defaultHarnessTools()` to `createRuntime` (or let
 * `createLatchApp` do it) and grant them per agent with `sandbox` /
 * `defaultTools`.
 *
 * A subpath because `web_fetch` has dependencies beyond `ai`: `turndown` and
 * `@intentface/latch-net` are OPTIONAL peers of core, imported lazily on the
 * first call. The core root imports none of them.
 */
export { defaultHarnessTools, sandboxTools, appTools, webFetchToModelOutput, harnessContextOf, tail } from "./tools.js";
export type { HarnessToolContext, WebFetchToolOutput } from "./tools.js";
// Types only: a runtime re-export of ./web-fetch.js would load the optional
// peers (turndown, latch-net) the moment this subpath is imported. The
// implementation is reached lazily by the web_fetch tool itself.
export type { WebFetchFormat, WebFetchResult, SupportedMediaType } from "./web-fetch.js";
