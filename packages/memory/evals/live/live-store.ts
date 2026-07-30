import { createMcpHost } from "@intentface/latch-mcp";
import type { ConnectionRegistry } from "@intentface/latch-core";
import { createLoredexStore } from "../../src/store/loredex.js";
import type { MemoryStore, ScopeRef } from "../../src/types.js";
import { createEvalOAuth, evalDiscoveryFetch, LIVE_CONNECTION, liveUrl } from "./eval-oauth.js";

/**
 * Live-eval wiring: the REAL `createLoredexStore` pointed at a dedicated
 * Loredex eval workspace, authenticated via OAuth (the endpoint is
 * OAuth-only). Run `pnpm eval:auth-live` once first — tokens live in
 * `~/.loredex-eval/vault.json` and the MCP transport auto-refreshes them.
 *
 * The scope mirrors the offline eval (`evals/run.ts`) exactly, so reports are
 * directly comparable: same root, same `memories/` folder, only the backend
 * differs. `LOREDEX_EVAL_URL` overrides the workspace endpoint.
 */

export const LIVE_SCOPE: ScopeRef = {
  key: `${LIVE_CONNECTION}:_memory/running-coach/u-eval`,
  connection: LIVE_CONNECTION,
  root: "_memory/running-coach/u-eval",
};

export interface LiveHandle {
  store: MemoryStore<unknown>;
  /** Raw per-connection tool access, for seeding (folder/file creation). */
  open: () => Promise<{
    call: (tool: string, input: unknown) => Promise<{ ok: boolean; text: string }>;
    close: () => Promise<void>;
  }>;
}

export async function createLiveStore(): Promise<LiveHandle> {
  const oauth = createEvalOAuth();
  if (!(await oauth.isAuthorized({}))) {
    console.error(
      "not authorized against the memory-eval workspace yet — run:\n  pnpm eval:auth-live",
    );
    process.exit(2);
  }

  const host = createMcpHost<unknown>({
    connections: [
      {
        name: LIVE_CONNECTION,
        url: liveUrl(),
        authProvider: oauth.provider({}),
        fetch: evalDiscoveryFetch(),
      },
    ],
    allowedHosts: [new URL(liveUrl()).hostname],
    onConnectionError: (name, error) => {
      console.error(`connection "${name}" failed to open: ${String(error)}`);
    },
  });

  const connections: ConnectionRegistry<unknown> = { hostFor: () => host };
  const store = createLoredexStore<unknown>({ connections });

  return {
    store,
    open: async () => {
      const opened = await host.open({});
      return {
        call: async (tool, input) => {
          const t = opened.tools[`${LIVE_CONNECTION}_${tool}`] as
            | { execute?: (input: unknown, options: unknown) => Promise<unknown> }
            | undefined;
          if (!t?.execute) return { ok: false, text: `tool not available: ${tool}` };
          try {
            const result = await t.execute(input, { toolCallId: "seed", messages: [] });
            const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
            const text = Array.isArray(r.content)
              ? r.content.map((c) => c.text ?? "").join("\n")
              : typeof result === "string"
                ? result
                : JSON.stringify(result);
            return { ok: !r.isError, text };
          } catch (error) {
            return { ok: false, text: String(error) };
          }
        },
        close: () => opened.close(),
      };
    },
  };
}
