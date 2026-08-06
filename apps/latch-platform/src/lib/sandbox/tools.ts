import { tool, jsonSchema } from "ai";
import type { Experimental_SandboxSession } from "ai";
import { Cron } from "croner";
import { parseTelegramChatId } from "@intentface/latch-channels/telegram";
import { parseSlackChatId } from "@intentface/latch-channels/slack";
import { webFetch } from "@/lib/web-fetch";
import { renderFetch, renderFetchConfigured } from "@/lib/render-fetch";
import { getLatch } from "@/lib/latch";
import { resolveDelivery, type ScheduleDelivery } from "@/lib/schedule-delivery";
import type { Principal } from "@/lib/session";

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
    "listing, moving, inspecting, and combining files with pipes. Depending " +
    "on the sandbox backend, the root may also hold READ-ONLY mounts of " +
    "connected services (e.g. /slack, /gdrive, /gmail, /gdocs, /gsheets, " +
    "/gslides) — run `ls /` to " +
    "discover them and browse with ls/cat/grep. Output is tail-truncated if " +
    "very long.",
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
const web_fetch = tool({
  description:
    "Fetch a public http(s) URL and return its content. HTML is converted to " +
    "clean markdown (default) or text — not raw markup — so it's compact and " +
    "readable. Runs in the app, not the sandbox; private/loopback hosts blocked.",
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
  execute: async ({ url, format, timeout }) => {
    const r = await webFetch({ url, format, timeout });
    if (!r.ok) return { ok: false as const, error: r.error };
    return {
      ok: true as const,
      status: r.status,
      contentType: r.contentType,
      body: r.content,
      truncated: r.truncated,
    };
  },
});

/**
 * The JS-page rung of the fetch ladder: renders the URL in a real headless
 * browser via the render service (packages/renderer). Sibling of web_fetch —
 * same guard, same app-process execution.
 */
const render_fetch = tool({
  description:
    "Fetch a URL in a real headless browser (JavaScript is executed) and " +
    "return the rendered visible text plus any schema.org JSON-LD (products, " +
    "prices, offers) and page links. Use when plain web_fetch returns a " +
    "JS-app shell, a cookie wall, an 'enable JavaScript' notice, or " +
    "navigation without the data. Slower and heavier than web_fetch — try " +
    "web_fetch first. Prefer the jsonLd in the result when present; it " +
    "carries exact structured data. For pages that need interaction before " +
    "the data appears (cookie wall, a tab to open, lazy content), drive it " +
    "with waitFor/clickSelector or an ordered `steps` script in the same " +
    "render pass.",
  inputSchema: jsonSchema<{
    url: string;
    include?: string;
    waitFor?: string;
    clickSelector?: string;
    steps?: {
      click?: string;
      waitFor?: string;
      scroll?: boolean;
      waitMs?: number;
    }[];
    scroll?: boolean;
  }>({
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-formed https URL to render." },
      include: {
        type: "string",
        description:
          'Comma-separated subset of: text, jsonLd, links, clickables, html. Default "text,jsonLd,links". Use "jsonLd" alone to save tokens when structured data suffices, "links" to discover subpages, "clickables" to see the buttons/inputs you can target in `steps`, "html" for raw markup.',
      },
      waitFor: {
        type: "string",
        description: "CSS selector to wait for before extracting (data that loads late).",
      },
      clickSelector: {
        type: "string",
        description: "CSS selector to click once before extracting (e.g. cookie-consent accept).",
      },
      steps: {
        type: "array",
        description:
          "Ordered actions run in the SINGLE render pass before extraction — for multi-step navigation (accept cookies → click a tab → scroll → read). Still one stateless render, not a live session. Use `include: \"clickables\"` first to discover selectors to target.",
        items: {
          type: "object",
          properties: {
            click: { type: "string", description: "CSS or text=Label selector to click." },
            waitFor: { type: "string", description: "Selector to wait for before continuing." },
            scroll: { type: "boolean", description: "Scroll to the bottom (lazy-loaded content)." },
            waitMs: { type: "number", description: "Fixed pause in ms (capped server-side)." },
          },
          additionalProperties: false,
        },
      },
      scroll: {
        type: "boolean",
        description: "Auto-scroll to the bottom once before extracting (triggers lazy content).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  execute: async (args) => renderFetch(args),
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

// ── Schedules ───────────────────────────────────────────────────────────────
// Let an agent set up its own recurring runs ("brief me every weekday at 8").
//
// Two things are deliberately NOT model-controlled:
//   • the agent — always the one the turn is running as, which keeps the
//     "a delivery bot serves exactly one agent" invariant true by construction;
//   • the delivery target — derived from the chat this turn is in, so a
//     prompt-injected agent cannot aim a recurring push at anyone else. In a
//     web chat there's no channel to derive, and the schedule is created
//     without delivery (it still shows up in the chat list and on /schedules).
//
// `create_schedule` is approval-gated by default (see `harnessTools.approval`),
// so in Telegram it surfaces as an Approve/Deny card before anything persists.

/** Refuse anything firing more often than this from the tool path. */
const MIN_SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
/** Ceiling on enabled schedules per principal, so a loop can't install hundreds. */
const MAX_SCHEDULES_PER_PRINCIPAL = 20;

/**
 * Would this cron ever fire twice within `minMs`? Checks the first few
 * occurrences rather than reasoning about the expression: a step of five
 * minutes and `0,1 8 * * *` are both too frequent, and only sampling catches
 * the second. An unparseable expression returns false so the tool rejects it.
 */
export function intervalAtLeast(
  expr: string,
  timezone: string | undefined,
  minMs: number,
): boolean {
  try {
    const cron = new Cron(expr, { timezone: timezone || "UTC" });
    let prev = cron.nextRun(new Date());
    if (!prev) return false; // never fires — nothing to schedule
    for (let i = 0; i < 5; i++) {
      const next = cron.nextRun(prev);
      if (!next) return true; // no further occurrence
      if (next.getTime() - prev.getTime() < minMs) return false;
      prev = next;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The delivery target implied by the chat a turn is running in, or undefined
 * for a web chat. This is the whole reason the model never names a recipient:
 * a schedule created from a Telegram DM can only ever push back into THAT DM.
 *
 * Slack chat ids carry the channel but not the app, so the app is recovered
 * from the agent binding — and only when it's unambiguous.
 */
async function deliveryForChat(
  chatId: string,
  principal: Principal,
  agentRef: string,
): Promise<ScheduleDelivery | undefined> {
  const tg = parseTelegramChatId(chatId);
  if (tg) return { kind: "telegram", botId: tg.botRef };

  const slack = parseSlackChatId(chatId);
  if (!slack) return undefined;
  const { slackStore } = await getLatch();
  const { parseAgentRef } = await import("@/lib/agent-store");
  const apps = await slackStore.appsForAgent(principal.orgId, parseAgentRef(agentRef).name);
  if (apps.length !== 1) return undefined;
  return { kind: "slack", appId: apps[0]!.appId, channel: slack.channel };
}

/** What the runtime puts on `options.context` (see runtime.ts `toolsContext`). */
type ToolCtx = {
  principal: Principal;
  run?: { id: string; chatId: string; agent: string };
};
const ctxOf = (o: unknown): ToolCtx => (o as { context?: ToolCtx }).context ?? ({} as ToolCtx);

const create_schedule = tool({
  description:
    "Schedule yourself to run again later, on a cron expression (or omit `cron` " +
    "for a one-off on the next tick). Each fire starts a fresh turn with `prompt` " +
    "as the message. When this conversation is on a chat channel, the result is " +
    "delivered back into it. Runs no more often than every 15 minutes. The user " +
    "confirms before anything is created.",
  inputSchema: jsonSchema<{ cron?: string; timezone?: string; prompt: string }>({
    type: "object",
    properties: {
      cron: {
        type: "string",
        description: "5-field cron, e.g. `0 8 * * 1-5`. Omit for a one-off run.",
      },
      timezone: {
        type: "string",
        description: "IANA timezone the cron is read in, e.g. `Europe/Helsinki`. Defaults to UTC.",
      },
      prompt: {
        type: "string",
        description: "The message to send yourself each fire. Write it as an instruction.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  }),
  execute: async (args, options) => {
    const { principal, run } = ctxOf(options);
    if (!principal || !run) return { error: "No principal for this turn." };
    const { runtime } = await getLatch();

    const existing = await runtime.listSchedules({ principal });
    if (existing.filter((s) => s.enabled).length >= MAX_SCHEDULES_PER_PRINCIPAL) {
      return {
        error: `You already have ${MAX_SCHEDULES_PER_PRINCIPAL} active schedules. Cancel one first (list_schedules / cancel_schedule).`,
      };
    }

    const cron = args.cron?.trim() || null;
    if (cron && !intervalAtLeast(cron, args.timezone, MIN_SCHEDULE_INTERVAL_MS)) {
      return {
        error:
          "That fires too often (or isn't a valid cron). The minimum interval is 15 minutes — " +
          "try something like `0 8 * * 1-5`.",
      };
    }

    // Derived, never taken from the model: which channel this chat belongs to.
    // Re-checked through the same gate the fire uses, so a target the caller
    // isn't entitled to is dropped rather than stored (the run still gets
    // scheduled — the user asked for that part).
    let delivery = await deliveryForChat(run.chatId, principal, run.agent);
    if (delivery) {
      try {
        await resolveDelivery(principal, run.agent, delivery);
      } catch (e) {
        console.warn("[create_schedule] derived delivery rejected:", e);
        delivery = undefined;
      }
    }
    try {
      const created = await runtime.schedule({
        principal,
        agent: run.agent,
        cron,
        timezone: args.timezone,
        prompt: args.prompt,
        delivery,
      });
      return {
        id: created.id,
        cron: created.cron ?? "one-off",
        timezone: created.timezone ?? "UTC",
        nextRunAt: new Date(created.nextRunAt).toISOString(),
        deliversTo: delivery ? delivery.kind : "this app only (no channel to deliver to)",
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Failed to create the schedule." };
    }
  },
});

const list_schedules = tool({
  description: "List the user's scheduled runs (all agents), with ids for cancel_schedule.",
  inputSchema: jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  execute: async (_args, options) => {
    const { principal } = ctxOf(options);
    if (!principal) return { error: "No principal for this turn." };
    const { runtime } = await getLatch();
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
    const { principal } = ctxOf(options);
    if (!principal) return { error: "No principal for this turn." };
    const { runtime } = await getLatch();
    // Ownership is enforced in storage (`deleteSchedule` is owner-fenced), so a
    // guessed id from another tenant simply deletes nothing.
    await runtime.unschedule({ principal, id: args.id });
    return { ok: true };
  },
});

/** Sandbox-backed tools (need an agent with `sandbox: true`). */
export const sandboxTools = { bash, read_file, write_file, glob, grep } as Record<string, unknown>;
/** App-runtime default tools (granted by `defaultTools`; no sandbox needed). */
export const appTools = {
  web_fetch,
  askUser,
  create_schedule,
  list_schedules,
  cancel_schedule,
} as Record<string, unknown>;
/**
 * Default gates for harness tools. Creating a schedule persists a recurring
 * side effect and — on a channel — a recurring push, so the user confirms it.
 * An agent may still override this in its own `toolApproval`.
 */
export const harnessApproval: Record<string, unknown> = {
  create_schedule: "user-approval",
};
/**
 * Render tool(s) — a separate capability (agent flag `renderTools: true`), NOT
 * part of `defaultTools`, so `defaultTools: true` never sweeps it in. Present
 * only when the render service is configured, so agents never see a dead tool.
 */
export const renderTools = (
  renderFetchConfigured() ? { render_fetch } : {}
) as Record<string, unknown>;
