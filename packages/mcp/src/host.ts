import {
  createMCPClient,
  type MCPClient,
  type MCPTransport,
  type OAuthClientProvider,
} from "@ai-sdk/mcp";
import type { SingleToolApprovalFunction, ToolApprovalStatus } from "ai";
import type { SecretResolver } from "@intentface/latch-core";
import {
  isBlockedHost,
  isBlockedResolved,
  isHostAllowed,
} from "@intentface/latch-net";
import type { FetchFunction } from "./oauth-fetch.js";

/**
 * The MCP host — connect to MCP servers and expose their tools to an agent,
 * with two Latch-specific guards on top of the SDK client:
 *
 *  1. A per-tenant SSRF allowlist: a connection's host must be explicitly
 *     permitted before we open a socket to it (and the transport rejects
 *     redirects, so a server can't bounce us somewhere else).
 *  2. Vault-brokered auth: bearer tokens are resolved per-tenant from the Vault
 *     and injected as request headers — they never appear in agent config.
 */

export type McpAuth =
  | { type: "bearer"; vaultKey: string }
  | { type: "headers"; headers: Record<string, string> };

/**
 * What the model sees of an MCP tool result, fixed for structured-only servers.
 *
 * The SDK's default `toModelOutput` maps `result.content` to model blocks and
 * only falls back to raw JSON when `content` is missing entirely. Newer MCP
 * servers (Airtable among them) return their payload in `structuredContent`
 * with `content: []` — the spec says they SHOULD mirror it into a text block,
 * but nothing enforces that — and the default then hands the model an empty
 * result while the stored message (what the UI renders) keeps the full object.
 * The agent reports "empty content" for a call that visibly succeeded.
 *
 * When `structuredContent` is present and `content` carries no text, the model
 * gets the structured payload as JSON instead. Everything else keeps the SDK's
 * behavior via `original`.
 */
export function withStructuredContentFallback(
  original: ((args: never) => unknown) | undefined,
): (args: { toolCallId: string; input: unknown; output: unknown }) => unknown {
  return (args) => {
    const result = args.output as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    } | null;
    if (
      result &&
      typeof result === "object" &&
      !result.isError &&
      result.structuredContent != null &&
      Array.isArray(result.content) &&
      // "No text": empty, or only parts with empty/absent text (some servers
      // pad with a blank text block instead of omitting content).
      result.content.every(
        (part) =>
          !(part as { type?: string; text?: string }).text?.trim?.() &&
          (part as { type?: string }).type === "text",
      )
    ) {
      return { type: "json", value: result.structuredContent };
    }
    return original
      ? (original as (a: typeof args) => unknown)(args)
      : { type: "json", value: args.output };
  };
}

/** MCP tool annotations (sensitivity hints) the server may advertise. */
export interface McpToolInfo {
  name: string;
  /** The server's tool description (what the model reads). */
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [k: string]: unknown;
  };
}

/**
 * Per-CALL approval decision for one tool: evaluated with the model's input
 * each time it calls the tool (synchronously or async — return `boolean` or
 * `Promise<boolean>`), so policy can key on ARGUMENTS. This is the escape
 * hatch for meta-tool servers — one `execute_tool` multiplexing every
 * operation through its arguments carries a single annotation set, so a
 * per-tool boolean can only gate everything or nothing.
 */
export type McpCallApproval = (input: unknown) => boolean | Promise<boolean>;

/**
 * Which of a connection's tools require human approval before running.
 * - `"destructive"` (default): respect MCP's built-in hints — gate any tool the
 *   server marks `destructiveHint: true` or explicitly `readOnlyHint: false`.
 * - `"all"` / `"none"`: gate every tool / no tool.
 * - a predicate: decide per tool from its annotations. Return a boolean for a
 *   whole-tool decision, or an {@link McpCallApproval} —
 *   `(input) => boolean | Promise<boolean>` — to decide per call (e.g. gate
 *   `execute_tool` only when `input.toolName` starts with `create_`).
 *   Annotations stay the first-class signal; the call function is for tools
 *   whose annotations structurally can't say enough.
 */
export type McpApprovalPolicy =
  | "destructive"
  | "all"
  | "none"
  | ((tool: McpToolInfo) => boolean | McpCallApproval);

/** The `"destructive"` rule: annotations say destructive / not read-only. */
function destructiveByAnnotations(tool: McpToolInfo): boolean {
  const a = tool.annotations ?? {};
  return a.destructiveHint === true || a.readOnlyHint === false;
}

/**
 * Apply an approval policy to one tool (defaults to `"destructive"`).
 * A function result means "decide per call with the input" — truthy for
 * gating purposes wherever a whole-tool answer is needed (a policy that must
 * be decided without input is treated conservatively as gated).
 */
export function needsMcpApproval(
  policy: McpApprovalPolicy | undefined,
  tool: McpToolInfo,
): boolean | McpCallApproval {
  const p = policy ?? "destructive";
  if (typeof p === "function") return p(tool);
  if (p === "all") return true;
  if (p === "none") return false;
  return destructiveByAnnotations(tool);
}

/**
 * One tool's value in the AI SDK's `toolApproval` map: an approval status
 * (`"user-approval"` = always gate; `undefined` = not applicable, never gate)
 * or a per-call function the SDK evaluates with the call input.
 */
export type McpToolApprovalValue =
  | ToolApprovalStatus
  | SingleToolApprovalFunction<unknown, unknown, unknown>;

/**
 * Resolve a policy to the value the AI SDK's `toolApproval` map takes for one
 * tool: `"user-approval"` (always gate), `undefined` (never gate), or a
 * per-call function the SDK evaluates with the call input.
 */
export function mcpApprovalValue(
  policy: McpApprovalPolicy | undefined,
  tool: McpToolInfo,
): McpToolApprovalValue {
  const gate = needsMcpApproval(policy, tool);
  if (typeof gate === "function") {
    // `undefined` is the SDK's "not-applicable" — the call runs ungated.
    return async (input: unknown) =>
      (await gate(input)) ? "user-approval" : undefined;
  }
  return gate ? "user-approval" : undefined;
}

/** Tuning for {@link nameHeuristicApproval} — extra verbs merged into the defaults. */
export interface NameHeuristicOptions {
  /** Verbs that mark a write (added to the built-in write list). */
  writeVerbs?: string[];
  /** Verbs that mark a destructive op (added to the built-in destructive list). */
  destructiveVerbs?: string[];
}

/** Default verbs a tool name may start with to count as a write. */
const DEFAULT_WRITE_VERBS = [
  "create",
  "update",
  "delete",
  "write",
  "remove",
  "set",
  "put",
  "post",
  "patch",
  "add",
  "insert",
  "edit",
  "move",
  "assign",
  "send",
  "cancel",
  "complete",
  "upsert",
  "publish",
  "share",
  "invite",
  "revoke",
  "merge",
  "duplicate",
  "copy",
  "archive",
  "destroy",
  "drop",
  "purge",
];

/** Default verbs a tool name may start with to count as destructive. */
const DEFAULT_DESTRUCTIVE_VERBS = [
  "delete",
  "remove",
  "drop",
  "destroy",
  "archive",
  "purge",
];

/** Normalize CamelCase/PascalCase (`CreateDeal`) → snake_case (`create_deal`). */
function normalizeToolName(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A generic approval predicate that gates a tool when either its MCP
 * annotations say it's destructive/non-read-only (the same rule
 * {@link needsMcpApproval} applies for `"destructive"`), OR — when the server
 * ships no annotations — the tool's name (normalized to snake_case) starts with
 * a write/destructive verb. Pure function; the returned predicate is stateless.
 *
 * Use it as an `approval` policy (or as a building block) for MCP servers whose
 * tools lack sensitivity hints.
 */
export function nameHeuristicApproval(
  opts?: NameHeuristicOptions,
): (tool: McpToolInfo) => boolean {
  const verbs = Array.from(
    new Set([
      ...DEFAULT_WRITE_VERBS,
      ...DEFAULT_DESTRUCTIVE_VERBS,
      ...(opts?.writeVerbs ?? []),
      ...(opts?.destructiveVerbs ?? []),
    ]),
  );
  const pattern = new RegExp(
    `^(${verbs.map(escapeRegExp).join("|")})([_\\W]|$)`,
    "i",
  );
  return (tool: McpToolInfo): boolean => {
    const a = tool.annotations ?? {};
    // Annotations are authoritative when present — reuse the destructive rule.
    if (a.readOnlyHint !== undefined || a.destructiveHint !== undefined) {
      return destructiveByAnnotations(tool);
    }
    // No hints — fall back to the tool-name verb heuristic.
    return pattern.test(normalizeToolName(tool.name));
  };
}

/**
 * A connection is either a URL (untrusted/config-driven → SSRF allowlist + auth
 * applies) or a developer-provided transport instance (trusted in-process; e.g.
 * stdio or an in-memory transport — no allowlist, it carries its own auth).
 */
export type McpConnection =
  | {
      /** Namespacing prefix for this server's tools (e.g. `linear` → `linear_*`). */
      name: string;
      /** MCP server URL (HTTP transport). */
      url: string;
      /** Static/bearer auth. Bearer tokens come from the Vault, per tenant. */
      auth?: McpAuth;
      /** OAuth provider (auto-refreshing). Build per scope via `McpOAuth.provider(scope)`. */
      authProvider?: OAuthClientProvider;
      /**
       * Custom fetch for this connection's requests AND the transport's on-401
       * re-auth/refresh. Pass the same fetch used by the OAuth flow (e.g.
       * `createOAuthDiscoveryFetch`) so discovery normalization is consistent.
       */
      fetch?: FetchFunction;
      /**
       * Permit this connection to reach a private/internal address. By default
       * the host rejects private/loopback/link-local IPs and DNS-rebinding
       * (a name that resolves private) even when the host is on the allowlist.
       * Set `true` only for a trusted local/in-cluster MCP server.
       */
      allowPrivateHost?: boolean;
      /** Which tools require approval (default: respect MCP destructive hints). */
      approval?: McpApprovalPolicy;
      /**
       * Tool visibility filter. When set, a tool for which this returns `false`
       * is dropped entirely — no agent tool, no approval entry. Use it to hide
       * tools an approval predicate can't express (e.g. a hard block). Absent →
       * all of the server's tools are exposed.
       */
      visible?: (tool: McpToolInfo) => boolean;
    }
  | {
      name: string;
      /** A prebuilt transport (stdio/in-memory/custom). Used as-is. */
      transport: MCPTransport;
      /** Which tools require approval (default: respect MCP destructive hints). */
      approval?: McpApprovalPolicy;
      /**
       * Tool visibility filter. When set, a tool for which this returns `false`
       * is dropped entirely — no agent tool, no approval entry. Use it to hide
       * tools an approval predicate can't express (e.g. a hard block). Absent →
       * all of the server's tools are exposed.
       */
      visible?: (tool: McpToolInfo) => boolean;
    };

export interface McpHostConfig<P> {
  /** Connections, static or resolved per caller (e.g. to inject OAuth providers). */
  connections:
    | McpConnection[]
    | ((principal: P) => McpConnection[] | Promise<McpConnection[]>);
  /**
   * SSRF allowlist of permitted hostnames. An entry beginning with `.` matches
   * that domain and its subdomains (`.example.com` → `example.com`,
   * `api.example.com`). Static, or resolved per caller.
   */
  allowedHosts: string[] | ((principal: P) => string[] | Promise<string[]>);
  /** Vault read-side, used for bearer auth. */
  secrets?: SecretResolver<P>;
  /** Observe a connection that failed to open (it's skipped, not fatal). */
  onConnectionError?: (name: string, error: unknown) => void;
}

export interface OpenMcp {
  /** Merged, name-prefixed tools, ready to spread into an agent's `tools`. */
  tools: Record<string, unknown>;
  /**
   * Per-tool approval policy derived from each connection's `approval` setting
   * and the MCP servers' tool annotations (`<name>_<tool>: "user-approval"`).
   * Merged into the agent's `toolApproval` by the runtime.
   */
  toolApproval: Record<string, McpToolApprovalValue>;
  /**
   * What each opened tool IS, keyed by the same namespaced name as `tools`:
   * the server-local name, description and annotations. For settings surfaces
   * that list a connection's tools (the `tools` values are opaque SDK objects).
   */
  toolInfos: Record<string, McpToolInfo>;
  /** Close every underlying client. Call when the turn finishes. */
  close(): Promise<void>;
}

export interface McpHost<P> {
  open(principal: P): Promise<OpenMcp>;
}

// Canonical implementation lives in @intentface/latch-net; re-exported here
// for callers that historically imported it from this package.
export { isHostAllowed };

/**
 * Resolve the request headers for a connection. Bearer tokens are read from the
 * Vault per tenant; the token is returned for immediate egress use and is never
 * logged or persisted by the host.
 */
export async function buildAuthHeaders<P>(
  conn: { name: string; auth?: McpAuth },
  principal: P,
  secrets?: SecretResolver<P>,
): Promise<Record<string, string>> {
  if (!conn.auth) return {};
  if (conn.auth.type === "headers") return { ...conn.auth.headers };
  // bearer
  if (!secrets) {
    throw new Error(
      `MCP connection "${conn.name}" needs bearer auth but no secrets resolver is configured`,
    );
  }
  const token = await secrets(principal, conn.auth.vaultKey);
  if (!token) {
    throw new Error(
      `MCP connection "${conn.name}": secret "${conn.auth.vaultKey}" not found for this tenant`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

export function createMcpHost<P>(config: McpHostConfig<P>): McpHost<P> {
  return {
    async open(principal) {
      const allowed =
        typeof config.allowedHosts === "function"
          ? await config.allowedHosts(principal)
          : config.allowedHosts;
      const connections =
        typeof config.connections === "function"
          ? await config.connections(principal)
          : config.connections;

      const clients: MCPClient[] = [];
      const tools: Record<string, unknown> = {};
      const toolApproval: Record<string, McpToolApprovalValue> = {};
      const toolInfos: Record<string, McpToolInfo> = {};
      const closeAll = () =>
        Promise.all(clients.map((c) => c.close().catch(() => {}))).then(
          () => undefined,
        );

      for (const conn of connections) {
        // SSRF guard is a HARD failure (security): an unlisted host throws,
        // before any socket opens.
        if (!("transport" in conn)) {
          const host = new URL(conn.url).hostname;
          if (!isHostAllowed(host, allowed)) {
            await closeAll();
            throw new Error(
              `MCP host not allowed for this tenant: ${host} (connection "${conn.name}")`,
            );
          }
          // Defense-in-depth beyond the allowlist: reject private/internal
          // addresses and DNS rebinding (an allowlisted name that resolves to a
          // private/link-local IP — e.g. cloud metadata at 169.254.169.254).
          // Opt out per connection for a trusted local server.
          if (
            !conn.allowPrivateHost &&
            (isBlockedHost(host) || (await isBlockedResolved(host)))
          ) {
            await closeAll();
            throw new Error(
              `MCP host resolves to a private/internal address: ${host} (connection "${conn.name}"). Set allowPrivateHost to permit a trusted local server.`,
            );
          }
        }
        // A connection that can't be opened (down / bad token / no tools) is
        // SKIPPED, not fatal — the agent degrades gracefully without it.
        try {
          let client: MCPClient;
          if ("transport" in conn) {
            client = await createMCPClient({
              transport: conn.transport,
            } as Parameters<typeof createMCPClient>[0]);
          } else {
            const headers = await buildAuthHeaders(conn, principal, config.secrets);
            client = await createMCPClient({
              transport: {
                type: "http",
                url: conn.url,
                headers,
                authProvider: conn.authProvider, // OAuth (auto-refresh) if present
                redirect: "error", // no redirect-based SSRF
                fetch: conn.fetch, // normalizing fetch for on-401 re-auth, if set
              },
            } as Parameters<typeof createMCPClient>[0]);
          }
          clients.push(client);
          // listTools (not tools()) so we keep the annotations the AI SDK's
          // tools() drops — they drive the approval policy. tools() is exactly
          // toolsFromDefinitions(listTools()), so this builds identical tools.
          const defs = await client.listTools();
          const serverTools = client.toolsFromDefinitions(defs);
          const defByName = new Map(
            (defs.tools ?? []).map((t) => [t.name, t] as const),
          );
          for (const [name, tool] of Object.entries(serverTools)) {
            const def = defByName.get(name);
            const info: McpToolInfo = {
              name,
              description: def?.description,
              annotations: def?.annotations,
            };
            // A hidden tool is dropped entirely (no tool, no approval entry) —
            // the primitive for a hard block, which approval can't express.
            if (conn.visible && !conn.visible(info)) continue;
            const key = `${conn.name}_${name}`; // namespace to avoid collisions
            // Patch the SDK's model-output mapping so structured-only results
            // (structuredContent + empty content) reach the model as JSON
            // instead of an empty block.
            const sdkTool = tool as { toModelOutput?: (args: never) => unknown };
            tools[key] = {
              ...sdkTool,
              toModelOutput: withStructuredContentFallback(sdkTool.toModelOutput),
            };
            toolInfos[key] = info;
            const approvalValue = mcpApprovalValue(conn.approval, info);
            if (approvalValue !== undefined) toolApproval[key] = approvalValue;
          }
        } catch (error) {
          config.onConnectionError?.(conn.name, error);
        }
      }

      return { tools, toolApproval, toolInfos, close: closeAll };
    },
  };
}
