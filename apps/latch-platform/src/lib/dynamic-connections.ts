import type {
  ConnectionRegistry,
  OpenToolSet,
  ToolSource,
} from "@intentface/latch-core";
import { createMcpHost, type McpAuth } from "@intentface/latch-mcp";
import {
  createOpenApiConnections,
  defineOpenApiConnection,
  headers as openApiHeaders,
  type OpenApiAuth,
} from "@intentface/latch-openapi";
import type { Principal } from "./session";
import type { ConnectionStore, StoredConnection } from "./connection-store";

/**
 * A ConnectionRegistry backed by the Vault-stored connections (added via UI).
 * `hostFor(names)` resolves an agent's declared names against the caller's
 * in-scope connections (org-shared + personal) at turn time and builds their
 * tools — MCP or OpenAPI — with the token brokered server-side. Names not found
 * in scope are simply absent (the agent degrades gracefully).
 */
const hostOf = (u: string) => new URL(u).hostname;

/** Stored token auth → MCP request headers. */
function mcpAuth(auth: StoredConnection["auth"]): McpAuth | undefined {
  if (!auth) return undefined;
  const headers =
    auth.kind === "bearer"
      ? { Authorization: `Bearer ${auth.token}` }
      : { [auth.header ?? "Authorization"]: auth.token };
  return { type: "headers", headers };
}

/** Stored token auth → OpenAPI header resolver (static). */
function openApiAuth(auth: StoredConnection["auth"]): OpenApiAuth<Principal> | undefined {
  if (!auth) return undefined;
  return openApiHeaders(
    auth.kind === "bearer"
      ? { Authorization: `Bearer ${auth.token}` }
      : { [auth.header ?? "Authorization"]: auth.token },
  );
}

export function createDynamicConnections(opts: {
  store: ConnectionStore;
}): ConnectionRegistry<Principal> {
  // Cache the OpenAPI registry per (name+spec+baseUrl) so the spec is fetched
  // and dereferenced once, not every turn.
  const openapiCache = new Map<
    string,
    ReturnType<typeof createOpenApiConnections<Principal>>
  >();

  function openapiSource(conn: StoredConnection): ToolSource<Principal> {
    const o = conn.openapi!;
    const sig = `${conn.name}:${o.spec}:${o.baseUrl ?? ""}`;
    let reg = openapiCache.get(sig);
    if (!reg) {
      const hosts = [hostOf(o.spec), ...(o.baseUrl ? [hostOf(o.baseUrl)] : [])];
      reg = createOpenApiConnections<Principal>({
        allowedHosts: hosts,
        connections: {
          [conn.name]: defineOpenApiConnection<Principal>({
            spec: o.spec,
            baseUrl: o.baseUrl,
            operations: o.operations ? { allow: o.operations } : undefined,
            auth: openApiAuth(conn.auth),
          }),
        },
      });
      openapiCache.set(sig, reg);
    }
    return reg.hostFor([conn.name]);
  }

  function mcpSource(conn: StoredConnection): ToolSource<Principal> {
    const url = conn.mcp!.url;
    return createMcpHost<Principal>({
      allowedHosts: [hostOf(url)],
      connections: [{ name: conn.name, url, auth: mcpAuth(conn.auth) }],
    });
  }

  return {
    hostFor: (names) => ({
      async open(principal): Promise<OpenToolSet> {
        const all = await opts.store.list(principal);
        // Keep requested names; personal precedence (user entries come last).
        const byName = new Map<string, StoredConnection>();
        for (const c of all) if (names.includes(c.name)) byName.set(c.name, c);

        const tools: Record<string, unknown> = {};
        const toolApproval: Record<string, unknown> = {};
        const closes: Array<() => Promise<void>> = [];
        for (const conn of byName.values()) {
          const source =
            conn.kind === "mcp" && conn.mcp
              ? mcpSource(conn)
              : conn.kind === "openapi" && conn.openapi
                ? openapiSource(conn)
                : undefined;
          if (!source) continue;
          const opened = await source.open(principal);
          Object.assign(tools, opened.tools);
          Object.assign(toolApproval, opened.toolApproval ?? {});
          closes.push(opened.close);
        }
        return {
          tools,
          toolApproval,
          close: () =>
            Promise.all(closes.map((c) => c().catch(() => {}))).then(() => undefined),
        };
      },
    }),
  };
}
