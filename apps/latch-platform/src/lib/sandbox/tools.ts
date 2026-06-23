import { tool, jsonSchema } from "ai";
import type { Experimental_SandboxSession } from "ai";

/**
 * The default harness tools, mirroring eve's set but implemented as thin
 * wrappers over the public AI SDK `Experimental_SandboxSession` (read via
 * `options.experimental_sandbox`). The sandbox set operates on the agent's
 * per-session workspace; `web_fetch` runs in the app process.
 *
 * Phase 1: bash, read_file, write_file, glob, grep (sandbox) + web_fetch (app).
 * Deferred: todo (durable list) and ask_question (→ awaiting_input pause).
 */

/** Tool execution options carry the sandbox the runtime resolved for the turn. */
type Opts = { experimental_sandbox?: Experimental_SandboxSession };
const sandboxOf = (o: unknown): Experimental_SandboxSession => {
  const s = (o as Opts).experimental_sandbox;
  if (!s) throw new Error("No sandbox available for this turn.");
  return s;
};

/** Single-quote a value for safe interpolation into a shell command. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Keep the tail of long output (errors/results usually land at the end). */
function tail(text: string, maxLines = 400, maxBytes = 20_000): { text: string; truncated: boolean } {
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

const bash = tool({
  description:
    "Run a shell command in the sandbox workspace (cwd /workspace). Use for " +
    "listing, moving, inspecting, and combining files with pipes. Output is " +
    "tail-truncated if very long.",
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
    return {
      exitCode: r.exitCode,
      stdout: so.text,
      stderr: se.text,
      truncated: so.truncated || se.truncated,
    };
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
    const text = await sandboxOf(options).readTextFile({
      path,
      startLine: start_line,
      endLine: end_line,
    });
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
    const r = await sandboxOf(options).run({
      command: `find ${q(path ?? ".")} -type f -name ${q(pattern)}`,
    });
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
    const r = await sandboxOf(options).run({
      command: `rg ${q(pattern)} ${q(path ?? ".")}`,
    });
    // rg exits 1 when there are no matches — that's not an error.
    const { text, truncated } = tail(r.stdout);
    return { matches: text, truncated, noMatches: r.exitCode === 1 && !r.stdout };
  },
});

/** Block obvious SSRF targets (loopback/private/link-local literals). Best-effort. */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "[::1]" || h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

const web_fetch = tool({
  description:
    "Fetch a public http(s) URL and return its text content (truncated). Runs " +
    "in the app, not the sandbox; private/loopback hosts are blocked.",
  inputSchema: jsonSchema<{ url: string }>({
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  }),
  execute: async ({ url }) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false as const, error: "Invalid URL." };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false as const, error: "Only http(s) URLs are allowed." };
    }
    if (isBlockedHost(u.hostname)) {
      return { ok: false as const, error: "Host is not allowed." };
    }
    const res = await fetch(u, { redirect: "follow" });
    const body = await res.text();
    const { text, truncated } = tail(body, 1000, 50_000);
    return { ok: true as const, status: res.status, body: text, truncated };
  },
});

/**
 * Ask the user one or more multiple-choice questions and wait for their answer.
 * Has NO `execute`: the SDK leaves the call in `input-available`, the turn
 * pauses, and the client renders a questionnaire and supplies the result via
 * `addToolResult` (output = a JSON object mapping each question → the picked
 * answer), which resumes the run. Mirrors intentface-chat's `askUser`.
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
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
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

/** Sandbox-backed tools (need an agent with `sandbox: true`). */
export const sandboxTools = { bash, read_file, write_file, glob, grep } as Record<string, unknown>;
/** App-runtime default tools (no sandbox needed). */
export const appTools = { web_fetch, askUser } as Record<string, unknown>;
