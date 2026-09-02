import { tool, jsonSchema } from "ai";
import type { Experimental_SandboxSession, Tool } from "ai";
import type { Runtime } from "../runtime.js";
import type { WebFetchFormat, WebFetchResult } from "./web-fetch.js";

/**
 * The default harness tools — what every host used to copy from the platform:
 *
 *  - sandbox: `bash` / `read_file` / `write_file` / `glob` / `grep`, thin
 *    wrappers over the AI SDK's `Experimental_SandboxSession` (read from
 *    `options.experimental_sandbox`, resolved per turn by `RuntimeConfig.sandbox`).
 *  - app: `web_fetch` (clean markdown/text, images/PDFs as viewable media,
 *    SSRF-gated, DNS-pinned), `askUser` (client-handled pause for a
 *    multiple-choice question), `list_schedules` / `cancel_schedule` (over the
 *    runtime the turn is running in — every tool receives it as
 *    `options.context.runtime`).
 *
 * `web_fetch` is the only tool with dependencies beyond `ai`: `turndown` and
 * `@intentface/latch-net` are OPTIONAL peers of core, imported lazily on first
 * call, so a host that never grants `web_fetch` never loads them.
 */

/** The model-facing tool-result shape (`ai` doesn't re-export it directly). */
type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;

/** Tool execution options carry the sandbox the runtime resolved for the turn. */
type SandboxOpts = { experimental_sandbox?: Experimental_SandboxSession };
const sandboxOf = (o: unknown): Experimental_SandboxSession => {
  const s = (o as SandboxOpts).experimental_sandbox;
  if (!s) throw new Error("No sandbox available for this turn.");
  return s;
};

/**
 * What the runtime puts on `options.context` for every tool (see
 * `buildTurn`'s toolsContext): the host's runtime context, the principal, the
 * run, the writer — and the runtime itself.
 */
export interface HarnessToolContext<P = unknown> {
  principal: P;
  run?: { id: string; chatId: string; agent: string };
  runtime?: Runtime<P>;
}
export const harnessContextOf = <P = unknown>(o: unknown): HarnessToolContext<P> =>
  (o as { context?: HarnessToolContext<P> }).context ?? ({} as HarnessToolContext<P>);

/** Single-quote a value for safe interpolation into a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Keep the tail of long output (errors/results usually land at the end). */
export function tail(text: string, maxLines = 400, maxBytes = 20_000): { text: string; truncated: boolean } {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(-maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out) > maxBytes) {
    out = out.slice(-maxBytes);
    truncated = true;
  }
  return { text: out, truncated };
}

// ── Sandbox tools ───────────────────────────────────────────────────────────

const bash = tool({
  description:
    "Run a shell command in the sandbox workspace (cwd /workspace). Use for " +
    "listing, moving, inspecting, and combining files with pipes. Depending " +
    "on the sandbox backend, the root may also hold READ-ONLY mounts of " +
    "connected services — run `ls /` to discover them and browse with " +
    "ls/cat/grep. Output is tail-truncated if very long.",
  inputSchema: jsonSchema<{ command: string }>({
    type: "object",
    properties: { command: { type: "string", description: "Shell command to run." } },
    required: ["command"],
    additionalProperties: false,
  }),
  execute: async ({ command }, options) => {
    const r = await sandboxOf(options).run({ command });
    const so = tail(r.stdout);
    const se = tail(r.stderr);
    return { exitCode: r.exitCode, stdout: so.text, stderr: se.text, truncated: so.truncated || se.truncated };
  },
});

const read_file = tool({
  description:
    "Read a text file from the sandbox, returned with 1-based line numbers. " +
    "Optionally restrict to a line range. Read before you write.",
  inputSchema: jsonSchema<{ path: string; start_line?: number; end_line?: number }>({
    type: "object",
    properties: {
      path: { type: "string" },
      start_line: { type: "number", description: "1-based inclusive start line." },
      end_line: { type: "number", description: "1-based inclusive end line." },
    },
    required: ["path"],
    additionalProperties: false,
  }),
  execute: async ({ path, start_line, end_line }, options) => {
    const text = await sandboxOf(options).readTextFile({ path, startLine: start_line, endLine: end_line });
    if (text == null) return { found: false as const };
    const start = start_line ?? 1;
    const numbered = text
      .split("\n")
      .map((l, i) => `${start + i}\t${l}`)
      .join("\n");
    return { found: true as const, content: numbered };
  },
});

const write_file = tool({
  description:
    "Write a complete file to the sandbox (overwrites; creates parent dirs). " +
    "Prefer reading the file first when editing an existing one.",
  inputSchema: jsonSchema<{ path: string; content: string }>({
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  }),
  execute: async ({ path, content }, options) => {
    await sandboxOf(options).writeTextFile({ path, content });
    return { ok: true, bytes: Buffer.byteLength(content) };
  },
});

const glob = tool({
  description:
    "Find files by name pattern (recursively from a directory, default the " +
    "workspace root). Pattern matches the file name, e.g. '*.ts'.",
  inputSchema: jsonSchema<{ pattern: string; path?: string }>({
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  }),
  execute: async ({ pattern, path }, options) => {
    const r = await sandboxOf(options).run({ command: `find ${q(path ?? ".")} -type f -name ${q(pattern)}` });
    const files = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    return { files: files.slice(0, 500), truncated: files.length > 500 };
  },
});

const grep = tool({
  description:
    "Search file contents by regex in the sandbox (ripgrep), returning " +
    "file:line:match. Searches the workspace root by default.",
  inputSchema: jsonSchema<{ pattern: string; path?: string }>({
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  }),
  execute: async ({ pattern, path }, options) => {
    // Plain `rg <pattern> <path>` already emits file:line:match.
    const r = await sandboxOf(options).run({ command: `rg ${q(pattern)} ${q(path ?? ".")}` });
    // rg exits 1 when there are no matches — that's not an error.
    const { text, truncated } = tail(r.stdout);
    return { matches: text, truncated, noMatches: r.exitCode === 1 && !r.stdout };
  },
});

// ── web_fetch ───────────────────────────────────────────────────────────────

/** web_fetch's stored output — text page, fetched media, or an error. */
export type WebFetchToolOutput =
  | { ok: true; kind?: "text"; status: number; contentType: string; body: string; truncated: boolean }
  | {
      ok: true;
      kind: "media";
      status: number;
      contentType: string;
      mediaType: string;
      /** Base64 bytes — surfaced to the model as an image/document block. */
      data: string;
      bytes: number;
      url: string;
    }
  | { ok: false; error: string };

/** Human-readable size — never "0 KB" for a real payload. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the model sees of a web_fetch result. Media becomes a real file block —
 * an image the model can look at, a PDF Anthropic renders as a document — with
 * a text line alongside so providers that can't take media in tool results
 * still leave the model oriented instead of staring at a silently-emptied
 * result. Text results keep the default JSON view.
 */
export function webFetchToModelOutput({ output }: { output: unknown }): ToolResultOutput {
  const r = output as WebFetchToolOutput;
  if (r && typeof r === "object" && r.ok && r.kind === "media") {
    return {
      type: "content",
      value: [
        { type: "text", text: `Fetched ${r.mediaType} (${formatBytes(r.bytes)}) from ${r.url}:` },
        { type: "file", mediaType: r.mediaType, data: { type: "data", data: r.data } },
      ],
    };
  }
  return { type: "json", value: output as never };
}

/** Lazy: `turndown` + `@intentface/latch-net` load on first use, never at import. */
let webFetchImpl: Promise<(args: { url: string; format?: WebFetchFormat; timeout?: number }) => Promise<WebFetchResult>> | undefined;
const loadWebFetch = () =>
  (webFetchImpl ??= import("./web-fetch.js").then((m) => m.webFetch).catch((e) => {
    webFetchImpl = undefined;
    throw new Error(
      `web_fetch needs its optional peers installed (turndown, @intentface/latch-net): ${e instanceof Error ? e.message : String(e)}`,
    );
  }));

const web_fetch = tool({
  description:
    "Fetch a public http(s) URL and return its content. HTML is converted to " +
    "clean markdown (default) or text — not raw markup — so it's compact and " +
    "readable. Images (png/jpeg/gif/webp) and PDFs are returned as viewable " +
    "attachments — you SEE them, not their bytes. Runs in the app, not the " +
    "sandbox; private/loopback hosts blocked.",
  inputSchema: jsonSchema<{ url: string; format?: "markdown" | "text" | "html"; timeout?: number }>({
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-formed http(s) URL to fetch." },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: 'Output format; HTML is converted to it. Defaults to "markdown".',
      },
      timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)." },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  execute: async ({ url, format, timeout }): Promise<WebFetchToolOutput> => {
    const webFetch = await loadWebFetch();
    const r = await webFetch({ url, format, timeout });
    if (!r.ok) return { ok: false, error: r.error };
    if (r.kind === "media") {
      return {
        ok: true,
        kind: "media",
        status: r.status,
        contentType: r.contentType,
        mediaType: r.mediaType,
        data: r.data,
        bytes: r.bytes,
        url,
      };
    }
    return { ok: true, status: r.status, contentType: r.contentType, body: r.content, truncated: r.truncated };
  },
  toModelOutput: webFetchToModelOutput,
});

// ── askUser ─────────────────────────────────────────────────────────────────

/**
 * Ask the user one or more multiple-choice questions and wait for their answer.
 * Has NO `execute`: the SDK leaves the call in `input-available`, the turn
 * pauses, and the client renders a questionnaire and supplies the result via
 * `addToolResult` (output = a JSON object mapping each question → the picked
 * answer), which resumes the run.
 */
const askUser = tool({
  description:
    "Ask the user one or more multiple-choice questions when you need a " +
    "decision or clarification before continuing. The conversation pauses " +
    "until the user answers. Prefer this over guessing.",
  inputSchema: jsonSchema<{
    questions: {
      question: string;
      header?: string;
      multiSelect?: boolean;
      options: { label: string; description: string }[];
    }[];
  }>({
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  }),
  // No `execute` — client-handled. The answer comes back via addToolResult.
});

// ── Schedules (read + cancel; creation is host policy) ──────────────────────
// Everything a tool needs is on `options.context`: the principal AND the
// runtime the turn runs in — no host-global required. Creating a schedule
// stays with the host (it decides delivery targets, rate floors, approval).

const list_schedules = tool({
  description: "List the user's scheduled runs (all agents), with ids for cancel_schedule.",
  inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
  execute: async (_args, options) => {
    const { principal, runtime } = harnessContextOf(options);
    if (!principal || !runtime) return { error: "No principal/runtime for this turn." };
    const schedules = await runtime.listSchedules({ principal });
    return {
      schedules: schedules.map((s) => ({
        id: s.id,
        agent: s.agent,
        cron: s.cron ?? "one-off",
        timezone: s.timezone ?? "UTC",
        prompt: s.prompt,
        enabled: s.enabled,
        nextRunAt: new Date(s.nextRunAt).toISOString(),
      })),
    };
  },
});

const cancel_schedule = tool({
  description:
    "Cancel one of the user's scheduled runs by id (from list_schedules). Use this " +
    "when they say to stop a recurring run.",
  inputSchema: jsonSchema<{ id: string }>({
    type: "object",
    properties: { id: { type: "string", description: "Schedule id from list_schedules." } },
    required: ["id"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { principal, runtime } = harnessContextOf(options);
    if (!principal || !runtime) return { error: "No principal/runtime for this turn." };
    // `unschedule` is owner-fenced and returns void, so a stale or foreign id
    // deletes nothing silently. Confirm it exists first — otherwise the model
    // tells the user a schedule was cancelled when it wasn't.
    const mine = await runtime.listSchedules({ principal });
    if (!mine.some((s) => s.id === args.id)) {
      return { error: `No schedule ${args.id} — call list_schedules for current ids.` };
    }
    await runtime.unschedule({ principal, id: args.id });
    return { cancelled: args.id };
  },
});

/** Sandbox-backed tools (need an agent with `sandbox: true`). */
export const sandboxTools = { bash, read_file, write_file, glob, grep } as Record<string, unknown>;
/** App-process default tools (granted by `defaultTools`; no sandbox needed). */
export const appTools = { web_fetch, askUser, list_schedules, cancel_schedule } as Record<string, unknown>;

/**
 * The `RuntimeConfig.harnessTools` bundle: sandbox + app tools, no default
 * approval gates (nothing here persists a side effect the user hasn't asked
 * for in the turn). Spread a host's own additions over `app` / `approval`.
 */
export function defaultHarnessTools(): {
  sandbox: Record<string, unknown>;
  app: Record<string, unknown>;
  approval: Record<string, unknown>;
} {
  return { sandbox: { ...sandboxTools }, app: { ...appTools }, approval: {} };
}
