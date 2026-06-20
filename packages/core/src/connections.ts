import type { OpenToolSet, ToolSource } from "./agent.js";
import type { ConnectionRegistry } from "./runtime.js";

/**
 * Combine tool sources into one: `open` opens all of them and merges their
 * tools + approval policies; `close` tears them all down. Later sources win on
 * key collisions (namespacing avoids that in practice).
 */
export function mergeToolSources<P>(...sources: ToolSource<P>[]): ToolSource<P> {
  return {
    async open(principal): Promise<OpenToolSet> {
      const opened = await Promise.all(sources.map((s) => s.open(principal)));
      const tools: Record<string, unknown> = {};
      const toolApproval: Record<string, unknown> = {};
      for (const o of opened) {
        Object.assign(tools, o.tools);
        Object.assign(toolApproval, o.toolApproval ?? {});
      }
      return {
        tools,
        toolApproval,
        close: () =>
          Promise.all(opened.map((o) => o.close().catch(() => {}))).then(() => undefined),
      };
    },
  };
}

/**
 * Combine connection registries of different kinds (e.g. MCP + OpenAPI) into one
 * the runtime can use. An agent's `connections: [...]` then resolves across all
 * of them — each registry's `hostFor` ignores names it doesn't own, so the
 * merged source is the union of whatever each kind contributes for those names.
 */
export function mergeConnections<P>(
  ...registries: ConnectionRegistry<P>[]
): ConnectionRegistry<P> {
  return {
    hostFor: (names) =>
      mergeToolSources(...registries.map((r) => r.hostFor(names))),
  };
}
