/**
 * Everything the lab runs, in one place: the database, the tools, and the
 * extensions. The route does one thing — call the loop. Every capability below
 * is an extension, not a change to the runtime.
 */
import Database from "better-sqlite3";
import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import {
  compaction,
  costTracking,
  defineExtension,
  truncateToolOutput,
  type Extension,
  type ModelPrice,
} from "@intentface/agents-sdk";
import {
  listChats,
  loadMessages,
  loadPrincipal,
  migrate,
  readSpend,
  sqlitePersistence,
  sqliteSpend,
  type SqliteDatabase,
} from "@intentface/agents-sdk/sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { owner, type LabPrincipal } from "./principal";

const DB_PATH = process.env.AGENTS_LAB_DB ?? ".data/lab.db";

let cached: SqliteDatabase | undefined;
export function db(): SqliteDatabase {
  if (cached) return cached;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH) as unknown as SqliteDatabase;
  d.exec("PRAGMA journal_mode = WAL;");
  migrate(d);
  cached = d;
  return d;
}

export { listChats, loadMessages, loadPrincipal, readSpend, owner };

export const model = anthropic(process.env.AGENTS_LAB_MODEL ?? "claude-sonnet-5");

// --- tools -----------------------------------------------------------------

export const tools = {
  listFiles: tool({
    description: "List the files in the workspace.",
    inputSchema: z.object({}),
    execute: async () => ({
      files: ["notes.md", "budget.csv", "old-backup.zip", "screenshot.png"],
    }),
  }),

  deleteFile: tool({
    description: "Permanently delete a file from the workspace.",
    inputSchema: z.object({ name: z.string().describe("The file to delete") }),
    needsApproval: true,
    execute: async ({ name }) => ({ deleted: name, at: new Date().toISOString() }),
  }),

  wordCount: tool({
    description: "Count the words in a piece of text.",
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ words: text.trim().split(/\s+/).filter(Boolean).length }),
  }),

  /** Who is asking. Reads the principal from the SDK's native tool context. */
  whoami: tool({
    description: "Report which organization and user this conversation belongs to.",
    inputSchema: z.object({}),
    execute: async (_input, o: { context: { principal: LabPrincipal } }) => ({
      orgId: o.context.principal.orgId,
      userId: o.context.principal.userId,
    }),
  }),

  // --- client tools: declared here, run by the browser ----------------------
  // No `execute`. The call is left unanswered, which ENDS the run, exactly as
  // an approval does. The browser answers it and the next run continues.

  browserContext: tool({
    description:
      "Read the viewer's timezone, locale and screen size from their browser. Use when local time or formatting matters.",
    inputSchema: z.object({}),
  }),

  askUser: tool({
    description: "Ask the person a direct question and wait for their typed answer.",
    inputSchema: z.object({
      question: z.string().describe("The question to put to them"),
      placeholder: z.string().optional().describe("Hint text for the input box"),
    }),
  }),
};

// --- extensions ------------------------------------------------------------

const dateline = defineExtension("dateline", (ext) =>
  ext.context(() => `Today is ${new Date().toDateString()}.`, {
    scope: "session",
    position: "system",
  }),
) as Extension;

/**
 * Policy as an extension. It reads the principal from the moment rather than
 * closing over one, so it cannot disagree with what the store recorded.
 */
const protectBackups = defineExtension("protect-backups", (ext) =>
  ext.on("tool_call", ({ toolName, input }) => {
    const name = (input as { name?: string } | undefined)?.name ?? "";
    if (toolName === "deleteFile" && name.includes("backup"))
      return { block: true, reason: "Backups are protected and cannot be deleted from here." };
    return undefined;
  }),
) as Extension;

const trace = defineExtension("trace", (ext) =>
  ext.notify((info) =>
    info.toolCalls.length
      ? `${info.toolCalls.map((c) => c.toolName).join(", ")} · ${info.durationMs}ms`
      : `${info.durationMs}ms`,
  ),
) as Extension;

const commands = defineExtension("commands", (ext) => {
  ext.registerCommand("help", {
    description: "What this lab can do",
    handler: async () =>
      [
        "This is a workbench for the experimental agents-sdk.",
        "",
        "Server tools: listFiles, wordCount, whoami, deleteFile (asks you first).",
        "Browser tools: browserContext, askUser — these run on your machine.",
        "Commands: /help, /whoami, /tidy.",
        "",
        "Try: delete old-backup.zip (an extension refuses it),",
        "delete notes.md (you get an approval card),",
        "or /whoami (the run ends, your browser answers, the run resumes).",
      ].join("\n"),
  });
  ext.registerCommand("whoami", {
    description: "What the agent knows about you",
    expand: async () =>
      "Use whoami and browserContext, then tell me my organization and timezone in one sentence.",
  });
  ext.registerCommand("tidy", {
    description: "Ask for a cleanup plan",
    expand: async () =>
      "List the workspace files and suggest which look safe to delete. Do not delete anything yet.",
  });
}) as Extension;

/**
 * Progressive disclosure, borrowed from pi's `dynamic-tools`.
 *
 * Destructive tools stay OUT of the toolset until the agent has actually
 * looked at the workspace. A model that cannot see `deleteFile` cannot call it
 * speculatively, which is a cheaper guarantee than approving every call — the
 * approval still fires afterwards, this just stops the conversation starting
 * with a deletion.
 */
const progressiveTools = defineExtension("progressive-tools", (ext) =>
  ext.on("step_start", (ctx) => {
    const looked = ctx.messages.some((m) =>
      (m.parts as Array<{ type: string; state?: string }>).some(
        (p) => p.type === "tool-listFiles" && p.state === "output-available",
      ),
    );
    const base = ["listFiles", "wordCount", "whoami", "browserContext", "askUser"];
    return { activeTools: looked ? [...base, "deleteFile"] : base };
  }),
) as Extension;

/**
 * Finish what you started, borrowed from pi's `send-user-message`.
 *
 * A run that ends on "let me check that" has announced work it never did.
 * `follow_up` revives it once so the sentence becomes an action. Bounded on
 * purpose: nothing else stops an extension that always returns messages, so it
 * fires at most once per run and only on the narrow phrasing below.
 *
 * A FACTORY, not a constant, because the `nudged` flag is per run. Built once
 * at module load it would fire a single time for the whole process and never
 * again — the same trap the persistence and cost extensions avoid by being
 * constructed per request.
 */
const finishTheThought = () => defineExtension("finish-the-thought", (ext) => {
  let nudged = false;
  ext.on("follow_up", (ctx) => {
    if (nudged) return;
    const last = ctx.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    const text = (last.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join(" ");
    // A question is the model ASKING, not announcing — "shall I go ahead?" is
    // the opposite of unfinished work, and nudging it there just makes it
    // repeat itself.
    if (/\?\s*$/.test(text.trim())) return;
    // "Let me know if…" is the single most common phrase in an assistant reply
    // and also means the opposite of "let me check that". Running this against
    // a real model tripped on it immediately; the mock never would have.
    if (!/\b(let me (?!know\b)|I'?ll now\b|I'?m going to\b|one moment\b)/i.test(text)) return;
    nudged = true;
    return {
      messages: [
        {
          id: `followup-${crypto.randomUUID()}`,
          role: "user",
          parts: [
            {
              type: "text",
              text: "You said you were about to do something. Do it now, then report the result.",
            },
          ],
        } as never,
      ],
    };
  });
}) as Extension;

export const INSTRUCTIONS = [
  "You are a concise assistant running inside a workbench for a new agent runtime.",
  "You have a small toy workspace you can list and delete files from.",
  "Deleting asks the person first. If a deletion is refused, say so plainly and move on.",
  "browserContext and askUser run in the person's browser, so they take a moment; use them only when needed.",
  "Keep answers short.",
].join(" ");

/**
 * Prices per MILLION tokens. Published Anthropic rates at the time of writing;
 * check them before trusting a bill. The cache rate is most of why a long
 * agent conversation is affordable.
 */
const PRICING: Record<string, ModelPrice> = {
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const ORG_LIMIT = Number(process.env.AGENTS_LAB_ORG_LIMIT ?? 1);
export const USER_LIMIT = Number(process.env.AGENTS_LAB_USER_LIMIT ?? 0.25);

/**
 * Extensions for one request.
 *
 * Order matters: persistence claims the chat first and saves last, so it leads.
 * The two budgets are the same extension twice with different keys — the
 * tighter ceiling stops the run, and both tallies stay accurate.
 */
export function extensionsFor(chatId: string, p: LabPrincipal): Extension[] {
  const d = db();
  return [
    sqlitePersistence(d, chatId, { owner }),
    // Summarising costs a model call, so it runs on the cheapest model we price.
    compaction({
      model: anthropic("claude-haiku-4-5"),
      afterMessages: Number(process.env.AGENTS_LAB_COMPACT_AFTER ?? 30),
      keepLast: 10,
    }),
    truncateToolOutput({ maxChars: 8_000 }),
    costTracking({
      name: "cost:org",
      pricing: PRICING,
      limit: ORG_LIMIT,
      ...sqliteSpend(d, p.orgId, "month"),
    }),
    costTracking({
      name: "cost:user",
      pricing: PRICING,
      limit: USER_LIMIT,
      ...sqliteSpend(d, p.userId, "day"),
    }),
    dateline,
    commands,
    progressiveTools,
    protectBackups,
    finishTheThought(),
    trace,
  ];
}

// No SLASH_COMMANDS constant on purpose: `/api/commands` derives the palette
// from `listCommands(extensionsFor(...))`, so the menu cannot disagree with the
// extensions that registered the commands.
