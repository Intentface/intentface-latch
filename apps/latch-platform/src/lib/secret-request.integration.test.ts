import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createRuntime, defineAgent, defineContext } from "@intentface/latch-core";
import type { Runtime, Vault } from "@intentface/latch-core";
import { createSqliteAdapter, migrate, schema } from "@intentface/latch-drizzle";
import { createNamedSecrets } from "./named-secrets";

/**
 * The security contract of the secret-entry flow, end to end.
 *
 * `request_secret` has no `execute`, so the turn parks. The BROWSER posts the
 * typed values to a server function that writes them to the Vault, and only
 * then resumes the run with a result carrying vault NAMES plus the non-secret
 * fields. This test drives that exact sequence and asserts the one thing that
 * must never be false: the plaintext appears nowhere in the persisted history
 * or in what the model is sent on the next step.
 */

type P = { orgId: string; userId: string };
const principal: P = { orgId: "org", userId: "user" };

const SECRET_VALUE = "sk_live_do_not_leak_me";
const SECRET_NAME = "strava_client_secret";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const streamFrom = (parts: unknown[]) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const meta = (id: string) => ({
  type: "response-metadata",
  id,
  modelId: "mock",
  timestamp: new Date(0),
});

let script: (() => unknown[])[] = [];
/** Every prompt the model was handed — the model-projection side of the check. */
let prompts: unknown[] = [];

const model = new MockLanguageModelV3({
  doStream: async (options) => {
    prompts.push(options.prompt);
    const next = script.shift() ?? (() => sayText("Nothing left to do."));
    return { stream: streamFrom(next()) };
  },
});

const sayText = (text: string) => [
  { type: "stream-start", warnings: [] },
  meta("r_text"),
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];

const callRequestSecret = (toolCallId: string) => [
  { type: "stream-start", warnings: [] },
  meta("r_secret"),
  {
    type: "tool-call",
    toolCallId,
    toolName: "request_secret",
    input: JSON.stringify({
      title: "Strava API credentials",
      scope: "user",
      fields: [
        { key: "clientId", label: "Client ID", secret: false },
        { key: "clientSecret", label: "Client Secret", secret: true, name: SECRET_NAME },
      ],
    }),
  },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
];

/** No `execute` — the SDK parks the call and the turn pauses, as in production. */
const agent = defineAgent<P>({
  model: model as never,
  instructions: "test agent",
  tools: {
    request_secret: tool({
      description: "ask for credentials",
      inputSchema: jsonSchema<{ title: string; scope: string; fields: unknown[] }>({
        type: "object",
        properties: { title: { type: "string" }, scope: { type: "string" }, fields: { type: "array" } },
        required: ["title", "scope", "fields"],
      }),
    }),
  },
});

function memoryVault(): Vault<P> {
  const data = new Map<string, string>();
  const k = (p: P, key: string) => `${p.orgId}/${p.userId}:${key}`;
  return {
    set: async (p: P, key: string, value: string) => void data.set(k(p, key), value),
    get: async (p: P, key: string) => data.get(k(p, key)),
    has: async (p: P, key: string) => data.has(k(p, key)),
    delete: async (p: P, key: string) => void data.delete(k(p, key)),
    list: async (p: P) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${p.orgId}/${p.userId}:`))
        .map((key) => key.slice(`${p.orgId}/${p.userId}:`.length)),
    resolver: { get: async () => undefined },
  } as unknown as Vault<P>;
}

async function drain(res: Response) {
  if (res.body) for await (const _ of res.body as unknown as AsyncIterable<unknown>) void _;
}

const isStream = (res: Response) =>
  (res.headers.get("content-type") ?? "").includes("text/event-stream");

const send = (runtime: Runtime<P>, chatId: string, text: string) =>
  runtime.handleChat({
    agent: "t",
    chatId,
    principal,
    message: { id: `u_${text}`, role: "user", parts: [{ type: "text", text }] } as never,
  });

describe("request_secret round trip", () => {
  let runtime: Runtime<P>;
  let secrets: ReturnType<typeof createNamedSecrets>;

  beforeEach(async () => {
    script = [];
    prompts = [];
    const client = createClient({ url: ":memory:" });
    await migrate(client);
    runtime = createRuntime<P, { orgId: string }>({
      storage: createSqliteAdapter<P>(drizzle(client, { schema }), {
        owner: (p) => [p.orgId, p.userId],
      }),
      context: defineContext<P, { orgId: string }>({
        build: ({ principal: p }) => ({ orgId: p.orgId }),
      }),
      agents: { t: agent },
    });
    secrets = createNamedSecrets(memoryVault() as never);
  });

  it("parks the turn, banks the value in the vault, and resumes with names only", async () => {
    const chatId = "chat_secret";
    script = [() => callRequestSecret("call_secret"), () => sayText("Creating the connection now.")];
    await drain(await send(runtime, chatId, "connect strava"));

    // The turn is parked on the form.
    const parked = await runtime.loadHistory({ chatId, principal });
    expect(
      (parked.at(-1)!.parts as Record<string, unknown>[]).find(
        (p) => p.type === "tool-request_secret" && p.state === "input-available",
      ),
    ).toMatchObject({ toolCallId: "call_secret" });

    // What the browser does: the secret goes to the vault directly…
    await secrets.set(principal, SECRET_NAME, "user", SECRET_VALUE);
    expect(await secrets.get(principal, SECRET_NAME, "user")).toBe(SECRET_VALUE);

    // …and only names + non-secret values resume the run.
    const res = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_secret",
      output: { saved: [SECRET_NAME], values: { clientId: "268672" }, declined: false },
    });
    expect(isStream(res)).toBe(true);
    await drain(res);

    const history = await runtime.loadHistory({ chatId, principal });

    // THE invariant: no plaintext anywhere in the durable conversation…
    expect(JSON.stringify(history)).not.toContain(SECRET_VALUE);
    // …nor in anything the model was ever handed.
    expect(JSON.stringify(prompts)).not.toContain(SECRET_VALUE);
    // The handle the agent works from did survive.
    expect(JSON.stringify(history)).toContain(SECRET_NAME);
    expect(JSON.stringify(history)).toContain("268672");
  });

  it("resumes cleanly when the user skips the form", async () => {
    const chatId = "chat_secret_skip";
    script = [
      () => callRequestSecret("call_skip"),
      () => sayText("No problem — we can add it later."),
    ];
    await drain(await send(runtime, chatId, "connect strava"));

    const res = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_skip",
      output: { saved: [], values: {}, declined: true },
    });
    expect(isStream(res)).toBe(true);
    await drain(res);

    const history = await runtime.loadHistory({ chatId, principal });
    const settled = (history.flatMap((m) => m.parts) as Record<string, unknown>[]).find(
      (p) => p.type === "tool-request_secret",
    );
    expect(settled).toMatchObject({ state: "output-available" });
    // The agent learns it was declined so it can offer another route.
    expect(JSON.stringify(settled)).toContain("declined");
    // And the turn actually continued rather than staying parked.
    expect(JSON.stringify(history)).toContain("No problem");
  });

  it("is idempotent — a duplicate submit does not start a second turn", async () => {
    const chatId = "chat_secret_dup";
    script = [() => callRequestSecret("call_dup"), () => sayText("Saved.")];
    await drain(await send(runtime, chatId, "connect strava"));

    const output = { saved: [SECRET_NAME], values: {}, declined: false };
    await drain(await runtime.applyToolResult({ chatId, principal, toolCallId: "call_dup", output }));
    const before = (await runtime.loadHistory({ chatId, principal })).length;

    const again = await runtime.applyToolResult({
      chatId,
      principal,
      toolCallId: "call_dup",
      output,
    });
    await drain(again);
    expect(isStream(again)).toBe(false);
    expect((await runtime.loadHistory({ chatId, principal })).length).toBe(before);
  });
});
