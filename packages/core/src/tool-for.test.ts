import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "./agent.js";
import { createRuntime } from "./runtime.js";
import { toolFor } from "./tool-for.js";
import { memoryStorage } from "./__tests__/memory-storage.js";
import { call, principal, scripted, text, type P } from "./__tests__/turn.js";

type Ctx = { greeting: (name: string) => string };

describe("toolFor", () => {
  it("types options.context as the app's context plus what Latch adds, and runs as a plain tool", async () => {
    const tool = toolFor<P, Ctx>();
    let seen: { greeting?: string; userId?: string; agent?: string } = {};
    const greet = tool({
      description: "Greet the user",
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }, { context }) => {
        expectTypeOf(context.greeting).toEqualTypeOf<(name: string) => string>();
        expectTypeOf(context.principal).toEqualTypeOf<P>();
        seen = { greeting: context.greeting(name), userId: context.principal.userId, agent: context.run.agent };
        return seen.greeting;
      },
    });

    const rt = createRuntime<P, Ctx>({
      storage: memoryStorage<P>().storage,
      context: async () => ({ greeting: (name) => `hello ${name}` }),
      agents: {
        greeter: defineAgent<P, Ctx>({ model: scripted([call("greet", '{"name":"Ada"}'), text("done")]), tools: { greet } }),
      },
    });
    const result = await rt.runAgent({ principal, agent: "greeter", prompt: "greet Ada" });

    expect(result.answer).toBe("done");
    expect(seen).toEqual({ greeting: "hello Ada", userId: principal.userId, agent: "greeter" });
  });

  it("has tool()'s shapes: execute guaranteed when given, and tools the client answers, with or without an outputSchema", () => {
    const tool = toolFor<P, Ctx>();
    const greet = tool({ inputSchema: z.object({ name: z.string() }), execute: async ({ name }) => name });
    // execute can't be undefined, so it's callable without a guard
    expectTypeOf<undefined extends typeof greet.execute ? true : false>().toEqualTypeOf<false>();
    const pick_date = tool({ description: "Ask the user for a date", inputSchema: z.object({ label: z.string() }) });
    expect(pick_date.execute).toBeUndefined();
    const pick_slot = tool({
      description: "Ask the user to pick a time slot",
      inputSchema: z.object({ day: z.string() }),
      outputSchema: z.object({ slot: z.string() }),
    });
    expect(pick_slot.execute).toBeUndefined();
  });
});
