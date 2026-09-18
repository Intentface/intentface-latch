import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntime, type Runtime } from "../runtime.js";
import { defineContext } from "../context.js";
import { defineAgent } from "../agent.js";
import type { AppMessage } from "../message.js";
import type { Extension } from "../extensions/extension.js";
import { memoryStorage } from "./memory-storage.js";

/**
 * One turn through `createRuntime` with extensions attached, for the tests
 * that exercise the moments. Returns what a test needs on all three surfaces:
 * the chunks the client received, what storage holds, and what the model was
 * asked (`model.doStreamCalls`).
 */

export type P = { orgId: string; userId: string };
export const principal: P = { orgId: "org_a", userId: "u_1" };

export type Step = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string };
export const text = (t: string): Step => ({ kind: "text", text: t });
export const call = (name: string, input = "{}"): Step => ({ kind: "tool", name, input });

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function streamFor(step: Step) {
  const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
  const chunks =
    step.kind === "text"
      ? [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "resp", modelId: "mock", timestamp: new Date(0) },
          { type: "text-start", id: "t0" },
          { type: "text-delta", id: "t0", delta: step.text },
          { type: "text-end", id: "t0" },
          finish("stop"),
        ]
      : [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "resp", modelId: "mock", timestamp: new Date(0) },
          { type: "tool-input-start", id: "call_1", toolName: step.name },
          { type: "tool-input-delta", id: "call_1", delta: step.input },
          { type: "tool-input-end", id: "call_1" },
          { type: "tool-call", toolCallId: "call_1", toolName: step.name, input: step.input },
          finish("tool-calls"),
        ];
  return { stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 0, chunks }) };
}

/** Each model call plays the next scripted step; the last one repeats. */
export function scripted(steps: Step[]) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => streamFor(steps[Math.min(n++, steps.length - 1)]!)) as never,
  });
}

/** The prompts a scripted model was sent, one per call. */
export const promptsOf = (model: MockLanguageModelV4) =>
  model.doStreamCalls.map((c) => c.prompt as Array<{ role: string; content: unknown }>);

/** SSE body → UI chunks. */
export async function chunksOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
}

export const user = (t: string, id = "u1"): AppMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: t }], metadata: { visibility: "user" } }) as AppMessage;

export interface TurnOptions {
  model: MockLanguageModelV4;
  tools?: Record<string, unknown>;
  toolApproval?: unknown;
  instructions?: string;
  /** Runtime-wide extensions. */
  extensions?: Extension[];
  /** The agent's own. */
  agentExtensions?: Extension[];
}

export function harness(o: TurnOptions) {
  const mem = memoryStorage<P>();
  const runtime: Runtime<P> = createRuntime<P>({
    storage: mem.storage,
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    extensions: o.extensions,
    agents: {
      a: defineAgent<P>({
        model: o.model,
        instructions: o.instructions ?? "Be brief.",
        tools: o.tools,
        toolApproval: o.toolApproval,
        extensions: o.agentExtensions,
      }),
    },
  });
  const turn = async (message: AppMessage, chatId = "chat_1") => {
    const chunks = await chunksOf(await runtime.handleChat({ agent: "a", principal, chatId, message }));
    return { chunks, stored: mem.messages.get(chatId) ?? [], run: [...mem.runs.values()].at(-1)! };
  };
  return { runtime, mem, turn };
}

/** The common case: one user message, one turn. */
export async function runTurn(o: TurnOptions & { message?: AppMessage }) {
  const h = harness(o);
  const out = await h.turn(o.message ?? user("hi"));
  return { ...out, ...h, prompts: promptsOf(o.model) };
}
