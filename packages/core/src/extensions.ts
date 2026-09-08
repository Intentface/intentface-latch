import type { AppMessage } from "./message.js";

/**
 * Agent extensions — work that runs BEFORE the model on a turn.
 *
 * An extension is a script over the turn's opened tools plus a template. The
 * script fetches what the agent already knows it needs (hours from Clockify,
 * open PRs, the customer record) and the template renders it into the user
 * turn or into the system prompt. Three triggers: `slash` (the user typed
 * `/report week`), `chat-start` (once per conversation, refreshable), and
 * `every-turn`.
 *
 * Core knows nothing about how scripts run or templates render — that is the
 * `ScriptEngine` seam (`RuntimeConfig.scripts`, implemented by
 * `@intentface/latch-script`). Core's job is the wiring and the invariant that
 * makes it safe:
 *
 *   The script's result is PERSISTED as a `data-extension` part on the
 *   triggering user message before the model runs. The model projection
 *   renders that part; the client projection redacts it. So what the model
 *   saw is always in the log, a crash-resume replays the identical prompt,
 *   and the user's own text is never rewritten.
 *
 * Scripts are read-only by default: a tool the turn's approval policy gates
 * is refused at analysis time unless the extension sets `allowMutations`.
 */

// ---------------------------------------------------------------- definition

export type ExtensionTrigger = "slash" | "chat-start" | "every-turn";

export interface AgentExtension {
  /** Identifier: `[a-z0-9_]`, unique per agent. A slash extension is invoked as `/<name>`. */
  name: string;
  /** Shown in the slash menu and to the Agent Builder. */
  description?: string;
  on: ExtensionTrigger;
  /**
   * JSON Schema for `input`. Informational in core (the runtime does not
   * validate against it); a text invocation yields `{ args, argv }`, a
   * structured one (`metadata.extension.input`) is passed through verbatim.
   */
  input?: Record<string, unknown>;
  /** Callscript JS text or its JSON plan. Runs over the turn's opened tools. */
  script?: string | object;
  /**
   * Liquid template over `{ input, output, steps, ...steps, error }`. Absent →
   * the script output is rendered as a fenced JSON block.
   */
  template?: string;
  /** Where the rendered text lands. Default `message`. */
  target?: "message" | "instructions";
  /** Message target: the rendered block goes before or after the user's text. Default `after`. */
  placement?: "before" | "after";
  /** Instructions target: this turn only, or every later turn of the chat. Default `turn`. */
  scope?: "turn" | "chat";
  /** `chat-start` only: run again when the last result is older than this. */
  refresh?: { afterMs?: number };
  /**
   * What the client sees on the user message: only the typed text (`command`),
   * the rendered prompt in its place (`prompt`), or both. Default `command`.
   */
  reveal?: "command" | "prompt" | "both";
  /** Let the script call approval-gated tools. Default false. */
  allowMutations?: boolean;
  /** A failed script: proceed with the failure visible to the model, or fail the turn. Default `proceed`. */
  onError?: "proceed" | "fail";
  limits?: {
    /** Script wall clock, ms. Default 30 000. */
    timeoutMs?: number;
    /** Cap on the rendered text the model sees. Default 50 000 chars. */
    maxRenderedChars?: number;
  };
}

// ---------------------------------------------------------------------- part

export const EXTENSION_PART_TYPE = "data-extension";

/** A file the script produced for the model — the AI SDK `FileUIPart` shape. */
export interface ExtensionFile {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
}

export interface ExtensionPartData {
  name: string;
  on: ExtensionTrigger;
  target: "message" | "instructions";
  placement: "before" | "after";
  scope: "turn" | "chat";
  reveal: "command" | "prompt" | "both";
  input?: unknown;
  /** When the script ran (epoch ms). */
  at: number;
  durationMs?: number;
  /** EXACTLY what the model sees — rendered, capped. Absent on failure. */
  rendered?: string;
  /** The script's return value, bounded (see `boundOutput`). */
  output?: unknown;
  outputTruncated?: boolean;
  /** Media for the model, emitted as `file` parts by the model projection. */
  files?: ExtensionFile[];
  /** Tool calls the script made. */
  calls: Array<{ tool: string; stepId: string }>;
  error?: { message: string; code?: string; at?: string };
}

export interface ExtensionPart {
  type: typeof EXTENSION_PART_TYPE;
  id: string;
  data: ExtensionPartData;
}

/** Structured invocation a client may stamp on the user message instead of typing `/name`. */
export interface ExtensionInvocation {
  name: string;
  input?: unknown;
}

// --------------------------------------------------------------------- engine

/** One tool as the engine sees it: a name, a card, and a bound `execute`. */
export interface ScriptToolMount {
  name: string;
  description?: string;
  /** JSON Schema of the arguments, for the engine's validation and cards. */
  inputSchema?: Record<string, unknown>;
  execute(args: unknown, ctx: { stepId: string; toolCallId: string }): Promise<unknown>;
}

export interface ScriptAnalysis {
  /** Engine-opaque compiled plan; absent when `issues` is non-empty. */
  plan?: unknown;
  /** Distinct tool names the script may call (worst case, conditional included). */
  calls: string[];
  /** Human-readable validation problems. Non-empty → the script must not run. */
  issues: string[];
}

export interface ScriptRunResult {
  status: "ok" | "error" | "suspended";
  output?: unknown;
  /** Settled step outputs by id. */
  steps: Record<string, unknown>;
  calls: Array<{ tool: string; stepId: string }>;
  error?: { message: string; code?: string; at?: string };
}

/**
 * The script seam. Implemented by `@intentface/latch-script` over callscript
 * and LiquidJS; core carries no dependency on either. Tool `execute`s are
 * pre-bound by core with the Latch tool context, so the engine never needs to
 * know what a Latch tool is.
 */
export interface ScriptEngine {
  /** Parse + validate against the mounted names. Synchronous, never throws. */
  analyze(script: string | object, opts: { tools: string[] }): ScriptAnalysis;
  run(
    plan: unknown,
    opts: {
      tools: ScriptToolMount[];
      input?: unknown;
      variables?: Record<string, unknown>;
      /** Abort: the engine must settle promptly once it fires. */
      signal?: AbortSignal;
    },
  ): Promise<ScriptRunResult>;
  render(template: string, scope: Record<string, unknown>): Promise<string>;
}

/** Thrown when an extension with `onError: "fail"` fails; the turn errors. */
export class ExtensionFailedError extends Error {
  readonly code = "extension_failed";
  /** The user message with the failed part appended — persist it so the failure is in the log. */
  partial?: ExecuteExtensionsResult;
  constructor(
    readonly extension: string,
    readonly detail: string,
  ) {
    super(`Extension "${extension}" failed: ${detail}`);
    this.name = "ExtensionFailedError";
  }
}

// ------------------------------------------------------------------- defaults

/** Names the chat channels claim for their own `/` commands — a slash extension may not use them. */
export const RESERVED_SLASH_NAMES: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "compact",
  "cancel",
  "skip",
  "status",
  "help",
  "commands",
  "start",
]);

export const EXTENSION_DEFAULTS = {
  timeoutMs: 30_000,
  maxRenderedChars: 50_000,
  maxOutputBytes: 64 * 1024,
  /** Same ceiling `web_fetch` applies — Anthropic caps images at 5 MB of source data. */
  maxMediaBytes: 4.5 * 1024 * 1024,
} as const;

/** Media types every provider's vision input accepts, plus PDF. */
export const EXTENSION_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

type Resolved = Required<
  Pick<AgentExtension, "target" | "placement" | "scope" | "reveal" | "allowMutations" | "onError">
> & { timeoutMs: number; maxRenderedChars: number };

export function resolveExtension(ext: AgentExtension): Resolved {
  return {
    target: ext.target ?? "message",
    placement: ext.placement ?? "after",
    scope: ext.scope ?? "turn",
    reveal: ext.reveal ?? "command",
    allowMutations: ext.allowMutations ?? false,
    onError: ext.onError ?? "proceed",
    timeoutMs: ext.limits?.timeoutMs ?? EXTENSION_DEFAULTS.timeoutMs,
    maxRenderedChars: ext.limits?.maxRenderedChars ?? EXTENSION_DEFAULTS.maxRenderedChars,
  };
}

// -------------------------------------------------------------------- parsing

/**
 * Same grammar as the channel kernel's `/command` parser (Telegram's, with an
 * optional `@bot` suffix). Only KNOWN names parse: `/Users/me/notes.txt` or an
 * unregistered `/foo` stays an ordinary message.
 */
const SLASH_RE = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/;

export interface SlashInvocation {
  name: string;
  /** Everything after the command word, trimmed. */
  args: string;
  argv: string[];
}

export function parseSlashInvocation(
  text: string,
  names: Iterable<string>,
): SlashInvocation | null {
  const m = SLASH_RE.exec(text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  let known = false;
  for (const n of names) {
    if (n.toLowerCase() === word) {
      known = true;
      break;
    }
  }
  if (!known) return null;
  const args = (m[3] ?? "").trim();
  return { name: word, args, argv: args ? args.split(/\s+/) : [] };
}

/** The message's text parts joined — what a slash parser reads. */
export function messageText(message: AppMessage | undefined): string {
  if (!message) return "";
  return (message.parts as Array<{ type?: unknown; text?: unknown }>)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

export function extensionPartsOf(message: AppMessage): ExtensionPart[] {
  const parts = (message as { parts?: Array<{ type?: unknown }> }).parts;
  if (!Array.isArray(parts)) return [];
  return parts.filter((p) => p.type === EXTENSION_PART_TYPE) as unknown as ExtensionPart[];
}

// ------------------------------------------------------------------ selection

export interface SelectedExtension {
  ext: AgentExtension;
  input?: unknown;
}

/**
 * Which extensions run on this turn. `window` is the live context window
 * (post-compaction) INCLUDING the current user message as its last element.
 *
 * - `slash`: a structured `metadata.extension` wins; else the text parses
 *   against the slash names. At most one slash extension per turn.
 * - `every-turn`: always.
 * - `chat-start`: when no earlier message in the window carries a result for
 *   it, or the latest one is older than `refresh.afterMs`. Compaction starts a
 *   new window, so a chat-start extension re-runs after a compaction.
 */
export function selectExtensions(opts: {
  extensions: readonly AgentExtension[];
  message: AppMessage | undefined;
  window: readonly AppMessage[];
  now: number;
}): SelectedExtension[] {
  const { extensions, message, window, now } = opts;
  if (!message || message.role !== "user") return [];
  const out: SelectedExtension[] = [];
  const earlier = window.filter((m) => m !== message && m.id !== message.id);

  const slashes = extensions.filter((e) => e.on === "slash");
  if (slashes.length > 0) {
    const structured = (message.metadata as { extension?: ExtensionInvocation } | undefined)
      ?.extension;
    const byName = (name: string) =>
      slashes.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (structured?.name && byName(structured.name)) {
      out.push({ ext: byName(structured.name)!, input: structured.input });
    } else {
      const parsed = parseSlashInvocation(
        messageText(message),
        slashes.map((e) => e.name),
      );
      if (parsed) {
        out.push({ ext: byName(parsed.name)!, input: { args: parsed.args, argv: parsed.argv } });
      }
    }
  }

  for (const ext of extensions) {
    if (ext.on === "every-turn") {
      out.push({ ext });
    } else if (ext.on === "chat-start") {
      const latest = latestPart(earlier, ext.name);
      if (!latest) out.push({ ext });
      else if (ext.refresh?.afterMs !== undefined && now - latest.data.at > ext.refresh.afterMs) {
        out.push({ ext });
      }
    }
  }
  return out;
}

function latestPart(messages: readonly AppMessage[], name: string): ExtensionPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = extensionPartsOf(messages[i]);
    for (let j = parts.length - 1; j >= 0; j--) {
      if (parts[j].data.name === name) return parts[j];
    }
  }
  return undefined;
}

/**
 * System-prompt blocks for this turn, read from the stored history: the latest
 * successful `target: "instructions"` result per extension name. `scope:
 * "chat"` results apply from anywhere in the window; `scope: "turn"` only when
 * they sit on the window's last user message. Reading from history (not
 * re-running) is what makes a resumed turn render identical instructions.
 */
export function extensionInstructionBlocks(window: readonly AppMessage[]): string[] {
  let lastUser = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const byName = new Map<string, string>();
  window.forEach((m, i) => {
    if (m.role !== "user") return;
    for (const p of extensionPartsOf(m)) {
      const d = p.data;
      if (d.target !== "instructions" || !d.rendered) continue;
      if (d.scope === "turn" && i !== lastUser) continue;
      byName.delete(d.name);
      byName.set(d.name, d.rendered);
    }
  });
  return [...byName.values()];
}

// ---------------------------------------------------------------- projections

/**
 * Model projection step: a `data-extension` part becomes what the model reads.
 * Message target → a text part with `rendered` before/after the user's text,
 * then any `files` as file parts. A failed extension → a short failure note so
 * the model can proceed (and call the tools itself). The data part itself is
 * always stripped — the SDK would drop it anyway; stripping keeps the rule
 * explicit. Projection-only: stored history is untouched.
 */
export function applyExtensionParts(messages: AppMessage[]): AppMessage[] {
  return messages.map((m) => {
    if (m.role !== "user") return m;
    const parts = (m as { parts?: Array<Record<string, unknown>> }).parts;
    if (!Array.isArray(parts)) return m;
    const ext = parts.filter((p) => p.type === EXTENSION_PART_TYPE) as unknown as ExtensionPart[];
    if (ext.length === 0) return m;
    const base = parts.filter((p) => p.type !== EXTENSION_PART_TYPE);
    const before: Array<Record<string, unknown>> = [];
    const after: Array<Record<string, unknown>> = [];
    for (const { data } of ext) {
      if (data.rendered && data.target === "message") {
        const block: Array<Record<string, unknown>> = [{ type: "text", text: data.rendered }];
        for (const f of data.files ?? []) block.push({ ...f });
        (data.placement === "before" ? before : after).push(...block);
      } else if (data.rendered && data.target === "instructions" && data.files?.length) {
        // The text went to the system prompt; media can only ride on a message.
        for (const f of data.files) after.push({ ...f });
      }
      if (data.error && !data.rendered) {
        after.push({
          type: "text",
          text: `[Extension "${data.name}" failed: ${data.error.message}. Proceed without it.]`,
        });
      }
    }
    // `before` goes ahead of the first text part; `after` behind the last text
    // part (files the user attached stay where they were).
    const firstText = base.findIndex((p) => p.type === "text");
    let lastText = -1;
    base.forEach((p, i) => {
      if (p.type === "text") lastText = i;
    });
    const next: Array<Record<string, unknown>> = [];
    base.forEach((p, i) => {
      if (i === firstText) next.push(...before);
      next.push(p);
      if (i === lastText) next.push(...after);
    });
    if (firstText === -1) next.unshift(...before);
    if (lastText === -1) next.push(...after);
    return { ...m, parts: next } as AppMessage;
  });
}

/**
 * Client projection step: with `reveal: "command"` the client learns that an
 * extension ran (name, when, error) but not what it produced — the rendered
 * prompt and the fetched data stay server-side. `prompt` / `both` pass the
 * part through whole; the client decides how to show it. Self-describing:
 * the stored part carries its own `reveal`, so editing the agent later does
 * not rewrite what an older message shows.
 */
export function redactExtensionParts(messages: AppMessage[]): AppMessage[] {
  return messages.map((m) => {
    const parts = (m as { parts?: Array<Record<string, unknown>> }).parts;
    if (!Array.isArray(parts)) return m;
    let changed = false;
    const next = parts.map((p) => {
      if (p.type !== EXTENSION_PART_TYPE) return p;
      const d = (p as unknown as ExtensionPart).data;
      if (!d || d.reveal !== "command") return p;
      changed = true;
      const reduced: Partial<ExtensionPartData> = {
        name: d.name,
        on: d.on,
        target: d.target,
        reveal: d.reveal,
        at: d.at,
        ...(d.input !== undefined ? { input: d.input } : {}),
        ...(d.error ? { error: { message: d.error.message } } : {}),
      };
      return { ...p, data: reduced };
    });
    return changed ? ({ ...m, parts: next } as AppMessage) : m;
  });
}

// ------------------------------------------------------------------- bounding

/** Keep a script output row-sized: over the cap, store a marked preview instead. */
export function boundOutput(
  output: unknown,
  maxBytes: number = EXTENSION_DEFAULTS.maxOutputBytes,
): { output: unknown; truncated: boolean } {
  if (output === undefined) return { output: undefined, truncated: false };
  let json: string;
  try {
    json = JSON.stringify(output) ?? "";
  } catch {
    return { output: { __unserializable: true }, truncated: true };
  }
  if (json.length <= maxBytes) return { output, truncated: false };
  return {
    output: { __truncated: true, bytes: json.length, preview: json.slice(0, 4000) },
    truncated: true,
  };
}

/**
 * Media the script returned for the model: a `files` list on the output, each
 * `{ mediaType, url | data (base64), filename? }` — `web_fetch`'s
 * `{ kind: "media", mediaType, data }` result fits as-is. Unsupported types
 * and anything past the byte cap are dropped, with a reason. Returns the
 * output WITHOUT `files` so the bytes are not stored twice.
 */
export function collectFiles(output: unknown): {
  output: unknown;
  files: ExtensionFile[];
  dropped: string[];
} {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { output, files: [], dropped: [] };
  }
  const { files: raw, ...rest } = output as { files?: unknown } & Record<string, unknown>;
  if (!Array.isArray(raw)) return { output, files: [], dropped: [] };
  const files: ExtensionFile[] = [];
  const dropped: string[] = [];
  let total = 0;
  raw.forEach((item, i) => {
    const f = item as { mediaType?: unknown; url?: unknown; data?: unknown; filename?: unknown };
    const label = typeof f?.filename === "string" ? f.filename : `files[${i}]`;
    if (typeof f?.mediaType !== "string" || !EXTENSION_MEDIA_TYPES.has(f.mediaType)) {
      dropped.push(`${label}: unsupported media type ${String(f?.mediaType)}`);
      return;
    }
    let url: string;
    let bytes = 0;
    if (typeof f.url === "string" && /^(https?:|data:)/i.test(f.url)) {
      url = f.url;
      if (url.startsWith("data:")) bytes = Math.floor(((url.split(",")[1] ?? "").length * 3) / 4);
    } else if (typeof f.data === "string" && f.data.length > 0) {
      bytes = Math.floor((f.data.length * 3) / 4);
      url = `data:${f.mediaType};base64,${f.data}`;
    } else {
      dropped.push(`${label}: no url or data`);
      return;
    }
    if (total + bytes > EXTENSION_DEFAULTS.maxMediaBytes) {
      dropped.push(`${label}: over the ${Math.round(EXTENSION_DEFAULTS.maxMediaBytes / 1024 / 1024 * 10) / 10} MB media cap`);
      return;
    }
    total += bytes;
    files.push({
      type: "file",
      mediaType: f.mediaType,
      url,
      ...(typeof f.filename === "string" ? { filename: f.filename } : {}),
    });
  });
  return { output: rest, files, dropped };
}

// ------------------------------------------------------------ tool results

/**
 * Give a script the VALUE a tool produced, not the wire envelope. MCP tools
 * return `{ content: [{ type: "text", text }], structuredContent?, isError? }`
 * — fine for the model, useless for `output.changes.files`. Mirrors what an
 * MCP client adapter does: `structuredContent` wins; one text part that parses
 * as JSON becomes that value; several text parts join; anything else (files,
 * images, non-MCP shapes) passes through untouched. `isError` throws, so a
 * script's `try/catch` and the step's error branch see it as a failure.
 */
export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  if (!Array.isArray(r.content)) return result;
  const parts = r.content as Array<{ type?: unknown; text?: unknown }>;
  if (!parts.every((p) => p && typeof p === "object" && typeof p.type === "string")) return result;
  const texts = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string);
  if (r.isError === true) {
    throw Object.assign(new Error(texts.join("\n") || "tool returned an error"), { code: "tool_error" });
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
  if (texts.length === parts.length) {
    if (texts.length === 1) {
      const t = texts[0]!.trim();
      if (/^[[{]/.test(t)) {
        try {
          return JSON.parse(t);
        } catch {
          // not JSON after all — hand back the text
        }
      }
      return texts[0];
    }
    return texts.join("\n");
  }
  return result;
}

// ------------------------------------------------------------------- gating

/**
 * The approval-gated tool names for a turn: harness gates + each source's
 * defaults, with the agent's object-form policy winning per name. A function
 * policy cannot be enumerated, so every tool counts as gated (the same
 * conservative rule test runs use).
 */
export function gatedToolNames(opts: {
  harnessApproval: Record<string, unknown>;
  sourceApproval: Array<Record<string, unknown> | undefined>;
  agentApproval: unknown;
  allNames: Iterable<string>;
}): Set<string> {
  const gated = new Set<string>();
  for (const [k, v] of Object.entries(opts.harnessApproval)) if (v) gated.add(k);
  for (const s of opts.sourceApproval) {
    for (const [k, v] of Object.entries(s ?? {})) if (v) gated.add(k);
  }
  const agent = opts.agentApproval;
  if (agent && typeof agent !== "function") {
    for (const [k, v] of Object.entries(agent as Record<string, unknown>)) {
      if (v) gated.add(k);
      else gated.delete(k);
    }
  } else if (typeof agent === "function") {
    for (const k of opts.allNames) gated.add(k);
  }
  return gated;
}

// ------------------------------------------------------------------ execution

export interface ExecuteExtensionsResult {
  /** The user message with the new parts appended (same id). */
  message: AppMessage;
  parts: ExtensionPart[];
}

/**
 * Run the selected extensions and build their parts. Pure with respect to
 * storage — the caller persists `message` and streams `parts`. Never throws
 * for a `proceed` extension; throws `ExtensionFailedError` for a `fail` one.
 */
export async function executeExtensions(opts: {
  engine: ScriptEngine;
  selected: readonly SelectedExtension[];
  message: AppMessage;
  /** Every executable tool of the turn (gated and inactive included) — the
   *  script is validated against ALL of them so a refusal names its reason. */
  mounts: () => ScriptToolMount[];
  gatedNames: ReadonlySet<string>;
  /** Tools the agent's `enabledTools` hides from this turn (never run by a script). */
  inactiveNames?: ReadonlySet<string>;
  now?: () => number;
  newId?: () => string;
  /** Outer abort (e.g. the lease). */
  signal?: AbortSignal;
}): Promise<ExecuteExtensionsResult> {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => `ext_${Math.random().toString(36).slice(2, 12)}`);
  const parts: ExtensionPart[] = [];

  for (const { ext, input } of opts.selected) {
    const r = resolveExtension(ext);
    const startedAt = now();
    const data: ExtensionPartData = {
      name: ext.name,
      on: ext.on,
      target: r.target,
      placement: r.placement,
      scope: r.scope,
      reveal: r.reveal,
      ...(input !== undefined ? { input } : {}),
      at: startedAt,
      calls: [],
    };
    const fail = (message: string, code?: string, at?: string) => {
      data.error = { message, ...(code ? { code } : {}), ...(at ? { at } : {}) };
    };
    try {
      let scope: Record<string, unknown> = { input };
      if (ext.script !== undefined) {
        const all = opts.mounts();
        const names = all.map((t) => t.name);
        const inactive = opts.inactiveNames ?? new Set<string>();
        const analysis = opts.engine.analyze(ext.script, { tools: names });
        const inactiveCalls = analysis.calls.filter((c) => inactive.has(c));
        const gatedCalls = analysis.calls.filter((c) => opts.gatedNames.has(c));
        if (analysis.issues.length > 0) {
          const available = names.length
            ? ` Tools this script can call: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}.`
            : " No tools are mounted for this agent (are its connections saved and authorized?).";
          fail(analysis.issues.join("; ") + available, "invalid_script");
        } else if (inactiveCalls.length > 0) {
          fail(
            `calls tool(s) not enabled for this agent: ${inactiveCalls.join(", ")} (enable them under the agent's tools)`,
            "tool_not_enabled",
          );
        } else if (gatedCalls.length > 0 && !r.allowMutations) {
          fail(
            `calls approval-gated tool(s) ${gatedCalls.join(", ")}; set allowMutations to permit`,
            "gated_tool",
          );
        } else {
          {
            // Only what this extension may run: never inactive; gated only when allowed.
            const mounts = all.filter(
              (t) => !inactive.has(t.name) && (r.allowMutations || !opts.gatedNames.has(t.name)),
            );
            const ac = new AbortController();
            const onOuter = () => ac.abort(opts.signal?.reason);
            opts.signal?.addEventListener("abort", onOuter, { once: true });
            const timer = setTimeout(
              () => ac.abort(new Error(`timed out after ${r.timeoutMs} ms`)),
              r.timeoutMs,
            );
            (timer as { unref?: () => void }).unref?.();
            let result: ScriptRunResult;
            try {
              result = await opts.engine.run(analysis.plan, {
                tools: mounts,
                input,
                signal: ac.signal,
              });
            } finally {
              clearTimeout(timer);
              opts.signal?.removeEventListener("abort", onOuter);
            }
            data.calls = result.calls;
            if (result.status !== "ok") {
              const e = result.error ?? { message: `script ${result.status}` };
              fail(
                result.status === "suspended"
                  ? "script suspended (approvals inside extensions are not supported yet)"
                  : e.message,
                e.code ?? result.status,
                e.at,
              );
            } else {
              const media = collectFiles(result.output);
              if (media.files.length > 0) data.files = media.files;
              const bounded = boundOutput(media.output);
              data.output = bounded.output;
              if (bounded.truncated) data.outputTruncated = true;
              scope = {
                input,
                output: media.output,
                steps: result.steps,
                ...result.steps,
                ...(media.dropped.length ? { droppedFiles: media.dropped } : {}),
              };
              if (media.dropped.length > 0) {
                // Not a failure — the text still renders; the model just learns
                // some media did not make it.
                data.error = { message: `media dropped: ${media.dropped.join("; ")}`, code: "media_dropped" };
              }
            }
          }
        }
      }
      if (!data.error || data.error.code === "media_dropped") {
        let rendered: string;
        if (ext.template !== undefined) {
          rendered = await opts.engine.render(ext.template, scope);
        } else {
          const body = scope.output !== undefined ? scope.output : scope.steps;
          rendered =
            body === undefined
              ? ""
              : `\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
        }
        if (rendered.length > r.maxRenderedChars) {
          rendered = `${rendered.slice(0, r.maxRenderedChars)}\n[…truncated to ${r.maxRenderedChars} characters]`;
        }
        data.rendered = rendered;
      }
    } catch (e) {
      const err = e as { message?: unknown; code?: unknown };
      fail(
        typeof err?.message === "string" ? err.message : String(e),
        typeof err?.code === "string" ? err.code : undefined,
      );
    }
    data.durationMs = now() - startedAt;
    parts.push({ type: EXTENSION_PART_TYPE, id: newId(), data });
    if (data.error && !data.rendered && r.onError === "fail") {
      const err = new ExtensionFailedError(ext.name, data.error.message);
      err.partial = { message: withParts(opts.message, parts), parts };
      throw err;
    }
  }

  return { message: withParts(opts.message, parts), parts };
}

function withParts(message: AppMessage, parts: ExtensionPart[]): AppMessage {
  return { ...message, parts: [...(message.parts as unknown[]), ...parts] } as AppMessage;
}
