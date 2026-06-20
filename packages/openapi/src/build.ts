import { tool, jsonSchema } from "ai";
import type { OpenApiAuth } from "./auth.js";

/** A custom fetch (structurally `globalThis.fetch`). */
export type FetchFunction = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Which operations require human approval. Default `"mutating"` (gate non-GET). */
export type OpenApiApprovalPolicy =
  | "mutating"
  | "all"
  | "none"
  | ((op: { operationId: string; method: string }) => boolean);

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** True if `host` is permitted by the allowlist (exact, or `.suffix` subdomain). */
export function isHostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const a = entry.toLowerCase();
    if (a.startsWith(".")) return h === a.slice(1) || h.endsWith(a);
    return h === a;
  });
}

function needsApproval(
  policy: OpenApiApprovalPolicy | undefined,
  op: { operationId: string; method: string },
): boolean {
  const p = policy ?? "mutating";
  if (typeof p === "function") return p(op);
  if (p === "all") return true;
  if (p === "none") return false;
  return op.method.toLowerCase() !== "get"; // "mutating"
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Minimal OpenAPI shapes we read (the doc is already dereferenced). */
interface Oap {
  servers?: { url: string }[];
  paths?: Record<string, Record<string, OapOperation>>;
}
interface OapParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}
interface OapOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OapParam[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

/** Build the `{ path?, query?, body? }` input schema for one operation. */
function inputSchemaFor(op: OapOperation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const group = (loc: "path" | "query") => {
    const params = (op.parameters ?? []).filter((p) => p.in === loc);
    if (params.length === 0) return undefined;
    const props: Record<string, unknown> = {};
    const req: string[] = [];
    for (const p of params) {
      props[p.name] = { ...(p.schema ?? { type: "string" }), description: p.description };
      if (p.required) req.push(p.name);
    }
    return { type: "object", properties: props, required: req, additionalProperties: false };
  };

  const path = group("path");
  if (path) {
    properties.path = path;
    required.push("path");
  }
  const query = group("query");
  if (query) properties.query = query;

  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema) {
    properties.body = bodySchema;
    if (op.requestBody?.required) required.push("body");
  }

  return { type: "object", properties, required, additionalProperties: false };
}

export interface BuiltTools {
  tools: Record<string, unknown>;
  toolApproval: Record<string, unknown>;
}

/**
 * Turn a dereferenced OpenAPI 3.x document into one tool per operation. Tools
 * are principal-independent (auth is resolved at call time from the tool
 * context), so they can be built once and reused across turns/tenants.
 */
export function buildOpenApiTools<P>(args: {
  name: string;
  doc: Oap;
  baseUrl: string;
  auth?: OpenApiAuth<P>;
  approval?: OpenApiApprovalPolicy;
  operations?: { allow?: string[]; block?: string[] };
  allowedHosts: string[];
  fetchFn: FetchFunction;
}): BuiltTools {
  const { name, doc, baseUrl, auth, approval, operations, allowedHosts, fetchFn } = args;
  const tools: Record<string, unknown> = {};
  const toolApproval: Record<string, unknown> = {};
  const base = baseUrl.replace(/\/$/, "");

  const allowed = (opId: string) => {
    if (operations?.block?.includes(opId)) return false;
    if (operations?.allow && !operations.allow.includes(opId)) return false;
    return true;
  };

  for (const [rawPath, methods] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (methods as Record<string, OapOperation>)[method];
      if (!op) continue;
      const operationId =
        op.operationId ?? `${method}_${rawPath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      if (!allowed(operationId)) continue;

      const key = sanitizeName(`${name}_${operationId}`);
      const opPath = rawPath;

      tools[key] = tool({
        description: op.summary ?? op.description ?? `${method.toUpperCase()} ${rawPath}`,
        inputSchema: jsonSchema(inputSchemaFor(op) as never),
        execute: async (input: unknown, options: unknown) => {
          const { path = {}, query = {}, body } = (input ?? {}) as {
            path?: Record<string, string | number>;
            query?: Record<string, unknown>;
            body?: unknown;
          };
          // Template path params, then assemble the URL.
          let urlPath = opPath;
          for (const [k, v] of Object.entries(path)) {
            urlPath = urlPath.replace(`{${k}}`, encodeURIComponent(String(v)));
          }
          const url = new URL(base + urlPath);
          for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
          }
          // SSRF guard — the resolved host must be on the allowlist.
          if (!isHostAllowed(url.hostname, allowedHosts)) {
            return { error: `host not allowed: ${url.hostname}` };
          }
          const principal = (options as { context?: { principal?: P } })?.context?.principal as P;
          const authHeaders = auth ? await auth(principal) : {};
          const hasBody = body !== undefined && method !== "get";
          try {
            const res = await fetchFn(url.toString(), {
              method: method.toUpperCase(),
              headers: {
                accept: "application/json",
                ...(hasBody ? { "content-type": "application/json" } : {}),
                ...authHeaders,
              },
              body: hasBody ? JSON.stringify(body) : undefined,
              redirect: "error",
            });
            const text = await res.text();
            let data: unknown = text;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              /* non-JSON — return as text */
            }
            return res.ok ? data : { error: `HTTP ${res.status}`, status: res.status, body: data };
          } catch (e) {
            return { error: e instanceof Error ? e.message : "request failed" };
          }
        },
      });

      if (needsApproval(approval, { operationId, method })) {
        toolApproval[key] = "user-approval";
      }
    }
  }

  return { tools, toolApproval };
}
