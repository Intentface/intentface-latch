import SwaggerParser from "@apidevtools/swagger-parser";
import type {
  ConnectionRegistry,
  OpenToolSet,
  ToolSource,
} from "@intentface/latch-core";
import type { OpenApiAuth } from "./auth.js";
import {
  buildOpenApiTools,
  isHostAllowed,
  type BuiltTools,
  type FetchFunction,
  type OpenApiApprovalPolicy,
} from "./build.js";

/**
 * Declarative OpenAPI connection — turns an OpenAPI 3.x document into agent
 * tools, one per operation. A second connection *kind* next to MCP: it produces
 * a `ToolSource<P>` that slots into the same per-agent `connections: [...]` and
 * registry, reusing the SSRF allowlist, brokered auth, and approval gating.
 */
export interface OpenApiConnectionDef<P> {
  /** HTTPS URL of the spec (fetched once) or an inline parsed 3.x object. */
  spec: string | Record<string, unknown>;
  /** Human-readable purpose — helps the model choose the connection. */
  description?: string;
  /** Base URL operation paths resolve against. Defaults to the spec's first `servers[]`. */
  baseUrl?: string;
  /** Filter operations by `operationId` (allow/block). Essential for large specs. */
  operations?: { allow?: string[]; block?: string[] };
  /** Which operations require approval. Default `"mutating"` (gate non-GET). */
  approval?: OpenApiApprovalPolicy;
  /** Header resolver (where credential scope lives). See `apiKey`/`bearer`/`headers`. */
  auth?: OpenApiAuth<P>;
}

export function defineOpenApiConnection<P = unknown>(
  def: OpenApiConnectionDef<P>,
): OpenApiConnectionDef<P> {
  return def;
}

export interface OpenApiConnectionsConfig<P> {
  connections: Record<string, OpenApiConnectionDef<P>>;
  /** SSRF allowlist of permitted hostnames (covers BOTH the spec host and the API host). */
  allowedHosts: string[];
  /** Custom fetch for spec download + tool calls. Default `globalThis.fetch`. */
  fetch?: FetchFunction;
  /** Observe a connection that failed to build (it's skipped, not fatal). */
  onConnectionError?: (name: string, error: unknown) => void;
}

export function createOpenApiConnections<P>(
  config: OpenApiConnectionsConfig<P>,
): ConnectionRegistry<P> & { names: string[]; host: ToolSource<P> } {
  const fetchFn: FetchFunction =
    config.fetch ?? (globalThis.fetch as FetchFunction);
  const entries = Object.entries(config.connections);

  // Build each connection's tools once (the spec is static; auth is resolved
  // per-call from the tool context). Memoized as a promise per connection.
  const built = new Map<string, Promise<BuiltTools>>();

  async function buildOne(name: string, def: OpenApiConnectionDef<P>): Promise<BuiltTools> {
    let raw: Record<string, unknown>;
    if (typeof def.spec === "string") {
      const host = new URL(def.spec).hostname;
      if (!isHostAllowed(host, config.allowedHosts)) {
        throw new Error(`OpenAPI spec host not allowed: ${host} (connection "${name}")`);
      }
      const res = await fetchFn(def.spec, { redirect: "error" });
      if (!res.ok) throw new Error(`spec fetch failed: HTTP ${res.status}`);
      raw = (await res.json()) as Record<string, unknown>;
    } else {
      raw = def.spec;
    }
    // Resolve $ref/allOf so each operation has a concrete schema.
    const doc = (await SwaggerParser.dereference(raw as never)) as {
      servers?: { url: string }[];
      paths?: Record<string, Record<string, unknown>>;
    };
    const baseUrl = def.baseUrl ?? doc.servers?.[0]?.url;
    if (!baseUrl) {
      throw new Error(`OpenAPI connection "${name}" has no baseUrl and the spec lists no servers`);
    }
    return buildOpenApiTools<P>({
      name,
      doc: doc as never,
      baseUrl,
      auth: def.auth,
      approval: def.approval,
      operations: def.operations,
      allowedHosts: config.allowedHosts,
      fetchFn,
    });
  }

  function ensure(name: string, def: OpenApiConnectionDef<P>): Promise<BuiltTools> {
    let p = built.get(name);
    if (!p) {
      p = buildOne(name, def).catch((err) => {
        built.delete(name); // allow a retry on the next turn
        throw err;
      });
      built.set(name, p);
    }
    return p;
  }

  function makeHost(only?: Set<string>): ToolSource<P> {
    const inScope = entries.filter(([name]) => !only || only.has(name));
    return {
      async open(): Promise<OpenToolSet> {
        const tools: Record<string, unknown> = {};
        const toolApproval: Record<string, unknown> = {};
        for (const [name, def] of inScope) {
          try {
            const b = await ensure(name, def);
            Object.assign(tools, b.tools);
            Object.assign(toolApproval, b.toolApproval);
          } catch (error) {
            config.onConnectionError?.(name, error); // skip a broken connection
          }
        }
        return { tools, toolApproval, close: async () => {} };
      },
    };
  }

  return {
    host: makeHost(),
    hostFor: (names) => makeHost(new Set(names)),
    names: entries.map(([name]) => name),
  };
}
