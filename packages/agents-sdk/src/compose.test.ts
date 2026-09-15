/**
 * Dispatch rules, and the three places this differs from the prototype it came
 * from. Each difference was a defect found by running that prototype:
 *
 *  1. fail-open is not universal — a persistence extension whose database is
 *     down has not "produced no effect", it has lost the step;
 *  2. an injected message must not become the response anchor;
 *  3. `instructions` must be able to carry provider options, or prompt-cache
 *     breakpoints on the system prompt cannot be written as an extension.
 */
import { describe, it, expect, vi } from "vitest";
import type { SystemModelMessage, UIMessage } from "ai";
import { compose, ExtensionFailedError } from "./compose.js";
import { defineExtension, type Extension, type StepContext } from "./extension.js";

const msgs: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
// The augmentation in `principal.test.ts` is PROGRAM-WIDE, not file-scoped, so
// once any file declares a principal shape every file must supply it. That is
// the trade for having no `<P>` on any signature, and it is fine for an
// application, which has one principal. A library that must work with any
// principal cannot use augmentation.
const ctx: StepContext = {
  runId: "r1",
  principal: { orgId: "org_a", userId: "u_1" },
  stepNumber: 0,
  messages: msgs,
};
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
const run = { runId: ctx.runId, principal: ctx.principal };

const thrower = (name: string, moment: "before_agent_start" | "step_end", critical: boolean): Extension =>
  defineExtension(
    name,
    (ext) =>
      ext.on(moment, () => {
        throw new Error("connection reset");
      }),
    { critical },
  ) as Extension;

describe("failure isolation", () => {
  it("an ordinary extension that throws is reported and skipped", async () => {
    quiet();
    const c = compose([thrower("weather", "before_agent_start", false)]);
    await expect(c.messagesIn("before_agent_start", msgs, run)).resolves.toEqual(msgs);
  });

  it("a critical extension that throws fails the run", async () => {
    const c = compose([thrower("postgres", "step_end", true)]);
    await expect(
      c.stepEnd(msgs, {
        ...ctx,
        usage: {},
        finishReason: "stop",
        model: { provider: "m", modelId: "m" },
        durationMs: 1,
        toolCalls: [],
      }),
    ).rejects.toBeInstanceOf(ExtensionFailedError);
  });

  it("the failure names the extension and the moment", async () => {
    const c = compose([thrower("postgres", "before_agent_start", true)]);
    await c.messagesIn("before_agent_start", msgs, run).then(
      () => expect.unreachable("should have thrown"),
      (e: ExtensionFailedError) => {
        expect(e.extension).toBe("postgres");
        expect(e.moment).toBe("before_agent_start");
        expect((e.cause as Error).message).toBe("connection reset");
      },
    );
  });
});

describe("message injection", () => {
  const inject = (id: string): Extension =>
    defineExtension(id, (ext) =>
      ext.on("before_agent_start", () => ({
        inject: { id, role: "assistant", parts: [{ type: "data-ctx", data: id }] } as UIMessage,
      })),
    ) as Extension;

  it("lands before the final message, so it cannot become the response anchor", async () => {
    const out = await compose([inject("ctx")]).messagesIn("before_agent_start", msgs, run);
    expect(out.map((m) => m.id)).toEqual(["ctx", "u1"]);
    // The anchor is what `toUIMessageStream` merges into. It must still be the user turn.
    expect(out[out.length - 1]!.role).toBe("user");
  });

  it("several injections accumulate in extension order", async () => {
    const out = await compose([inject("a"), inject("b")]).messagesIn("before_agent_start", msgs, run);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "u1"]);
  });

  it("replace is last-wins and injections layer on top of it", async () => {
    const stored: UIMessage[] = [{ id: "s1", role: "user", parts: [{ type: "text", text: "stored" }] }];
    const replacer = defineExtension("store", (ext) =>
      ext.on("before_agent_start", () => ({ replace: stored })),
    ) as Extension;
    const out = await compose([replacer, inject("ctx")]).messagesIn("before_agent_start", msgs, run);
    expect(out.map((m) => m.id)).toEqual(["ctx", "s1"]);
  });
});

describe("instructions", () => {
  it("appends accumulate onto a string base", async () => {
    const a = defineExtension("a", (ext) => ext.on("instructions", () => ({ append: "one" }))) as Extension;
    const b = defineExtension("b", (ext) => ext.on("instructions", () => ({ append: "two" }))) as Extension;
    expect(await compose([a, b]).instructions("base", ctx)).toBe("base\none\ntwo");
  });

  it("a replace resets the base and discards earlier appends", async () => {
    const a = defineExtension("a", (ext) => ext.on("instructions", () => ({ append: "dropped" }))) as Extension;
    const b = defineExtension("b", (ext) => ext.on("instructions", () => ({ replace: "fresh" }))) as Extension;
    expect(await compose([a, b]).instructions("base", ctx)).toBe("fresh");
  });

  it("keeps provider options intact, so a cache breakpoint survives an append", async () => {
    // This is the shape prompt caching needs: a system message carrying
    // `providerOptions`. Narrowing the effect to `string` would flatten it and
    // silently drop the breakpoint.
    const cached: SystemModelMessage[] = [
      { role: "system", content: "stable prefix", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
    ];
    const caching = defineExtension("caching", (ext) =>
      ext.on("instructions", () => ({ replace: cached })),
    ) as Extension;
    const dateline = defineExtension("dateline", (ext) =>
      ext.on("instructions", () => ({ append: "Today is Sunday." })),
    ) as Extension;

    const out = (await compose([caching, dateline]).instructions(undefined, ctx)) as SystemModelMessage[];
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(out[1]).toEqual({ role: "system", content: "Today is Sunday." });
  });
});

describe("tool call vetoes", () => {
  const blocker = (reason: string): Extension =>
    defineExtension("gate", (ext) => ext.on("tool_call", () => ({ block: true, reason }))) as Extension;
  const allower = defineExtension("allow", (ext) => ext.on("tool_call", () => undefined)) as Extension;

  it("the first block wins", async () => {
    const c = compose([allower, blocker("first"), blocker("second")]);
    expect(await c.toolCall({ toolName: "rm", toolCallId: "c1", input: {} }, run)).toMatchObject({
      block: true,
      reason: "first",
    });
  });

  it("a throwing veto is not an accidental veto", async () => {
    quiet();
    const broken = defineExtension("broken", (ext) =>
      ext.on("tool_call", () => {
        throw new Error("boom");
      }),
    ) as Extension;
    expect(await compose([broken]).toolCall({ toolName: "rm", toolCallId: "c1", input: {} }, run)).toBeUndefined();
  });
});

describe("has", () => {
  it("reports which moments have listeners, so the tool wrapper can stay streaming-safe", () => {
    const only = defineExtension("only", (ext) => ext.on("tool_result", () => undefined)) as Extension;
    const c = compose([only]);
    expect(c.has("tool_result")).toBe(true);
    expect(c.has("tool_call")).toBe(false);
  });
});
