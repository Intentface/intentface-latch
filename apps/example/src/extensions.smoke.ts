import { createClient } from "@libsql/client";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  EXTENSION_PART_TYPE,
  createRuntime,
  defineAgent,
  defineContext,
  type AppMessage,
  type ExtensionPart,
} from "@intentface/latch-core";
import { createSqliteAdapter, migrate } from "@intentface/latch-drizzle";
import { createScriptEngine } from "@intentface/latch-script";
import { assert, latchDb, owner, type Principal } from "./setup.js";
import { tools } from "./tools.js";

/**
 * Agent extensions end to end, with the REAL engine (callscript + Liquid) over
 * the real drizzle adapter: a slash extension renders into the user turn, a
 * chat-start extension lands in the system prompt and persists across turns
 * without re-running, the part is stored on the user message, and the client
 * projection redacts it.
 */

type Prompt = Array<{ role: string; content: unknown }>;
const prompts: Prompt[] = [];
const model = new MockLanguageModelV4({
  modelId: "mock-model",
  doStream: (async ({ prompt }: { prompt: Prompt }) => {
    prompts.push(prompt);
    return {
      stream: simulateReadableStream({
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "Noted." },
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } },
        ],
      }),
    };
  }) as never,
});

const userText = (p: Prompt) =>
  p
    .filter((m) => m.role === "user")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
    .map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? "")))
    .join("\n");
const systemText = (p: Prompt) =>
  p.filter((m) => m.role === "system").map((m) => String(m.content));
const extParts = (m: AppMessage) =>
  (m.parts as Array<{ type: string }>).filter((x) => x.type === EXTENSION_PART_TYPE) as unknown as ExtensionPart[];

async function main() {
  console.log("extensions smoke");
  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const storage = createSqliteAdapter<Principal>(latchDb(client), { owner });
  const runtime = createRuntime<Principal, { orgId: string }>({
    storage,
    context: defineContext<Principal, { orgId: string }>({ build: ({ principal }) => ({ orgId: principal.orgId }) }),
    scripts: createScriptEngine(),
    resolvePromptCaching: () => undefined,
    agents: {
      reporter: defineAgent<Principal, { orgId: string }>(() => ({
        model,
        instructions: "You report times.",
        tools,
        extensions: [
          {
            name: "now",
            on: "slash",
            description: "The current time in a zone",
            script: `const t = await getCurrentTime({ timeZone: input.args || "UTC" }); return { t };`,
            template: "It is {{ output.t.formatted }} ({{ output.t.timeZone }}).",
          },
          {
            name: "home",
            on: "chat-start",
            target: "instructions",
            scope: "chat",
            script: `return { zone: "Europe/Helsinki" };`,
            template: "The user's home zone is {{ output.zone }}.",
          },
        ],
      })),
    },
  });
  const principal: Principal = { orgId: "org_a", userId: "user_1" };
  const chat = await storage.createChat(principal, { agent: "reporter" });
  const send = async (text: string) => {
    const message: AppMessage = {
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      parts: [{ type: "text", text }],
      metadata: { visibility: "user", createdAt: Date.now() },
    };
    const res = await runtime.handleChat({ agent: "reporter", chatId: chat.id, principal, message });
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
  };

  // Turn 1: a slash extension + the chat-start one.
  await send("/now Asia/Tokyo");
  const p1 = prompts[0]!;
  const u1 = userText(p1);
  assert(u1.startsWith("/now Asia/Tokyo"), "the model sees the typed text first");
  assert(/It is .+ \(Asia\/Tokyo\)\./.test(u1), `…then the rendered block (got: ${u1.slice(0, 120)})`);
  const s1 = systemText(p1);
  assert(s1.length === 2 && s1[0]!.includes("You report times."), "system: instructions+date joined first");
  assert(s1[1] === "The user's home zone is Europe/Helsinki.", "system: the chat-start block after the date line");
  let stored = await storage.loadMessages(principal, chat.id);
  const user1 = stored.find((m) => m.role === "user")!;
  const parts1 = extParts(user1);
  assert(parts1.length === 2, `two extension parts persisted on the user message (got ${parts1.length})`);
  const now = parts1.find((p) => p.data.name === "now")!;
  assert(now.data.calls.some((c) => c.tool === "getCurrentTime"), "the part records the tool call");
  assert(typeof now.data.rendered === "string" && now.data.rendered.includes("Asia/Tokyo"), "the part stores the rendered text");
  assert(stored.at(-1)?.role === "assistant", "the assistant answered");

  // The client projection redacts what the model saw (reveal: command).
  const history = await runtime.loadHistory({ chatId: chat.id, principal });
  const redacted = extParts(history[0]!)[0]!.data as unknown as Record<string, unknown>;
  assert(redacted.rendered === undefined && redacted.name === "now", "client sees the name, not the rendered prompt");

  // Turn 2: chat-start does not re-run; its block still applies.
  await send("thanks");
  const p2 = prompts[1]!;
  assert(systemText(p2)[1] === "The user's home zone is Europe/Helsinki.", "chat-start block persists on turn 2");
  stored = await storage.loadMessages(principal, chat.id);
  const user2 = stored.filter((m) => m.role === "user")[1]!;
  assert(extParts(user2).length === 0, "turn 2 ran no extension (chat-start reused, no slash)");
  assert(userText(p2).includes("It is ") && userText(p2).endsWith("thanks"), "turn 2 prompt replays turn 1's rendered part from the log");

  // Preview a draft without persisting anything.
  const before = (await storage.loadMessages(principal, chat.id)).length;
  const draft = await runtime.previewExtension({
    agent: "reporter",
    principal,
    extension: { name: "utc", on: "slash", script: `const t = await getCurrentTime({}); return t;`, template: "UTC: {{ output.iso }}" },
    text: "/utc",
  });
  assert(!!draft.rendered?.startsWith("UTC: 20"), "previewExtension renders a draft");
  assert((await storage.loadMessages(principal, chat.id)).length === before, "preview persists nothing");

  // A gated tool is refused before anything runs.
  const gated = await runtime.previewExtension({
    agent: "reporter",
    principal,
    extension: { name: "x", on: "slash", script: `return await connect_github({});` },
  });
  assert(gated.error?.code === "invalid_script", `an unmounted/gated tool is a validation error (${gated.error?.code})`);

  console.log("✅ extensions smoke passed");
}

main().catch((e) => {
  console.error("❌ extensions smoke failed:", e);
  throw e;
});
