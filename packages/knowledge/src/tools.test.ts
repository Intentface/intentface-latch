import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { createRuntime, defineAgent } from "@intentface/latch-core";
import { createPostgresAdapter, migratePostgres, pgSchema } from "@intentface/latch-drizzle";
import { simulateReadableStream, stepCountIs, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { createKnowledge, fromPGlite, knowledgeTools } from "./index.js";

type P = { org: string; user: string };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** Each model call plays the next step: a tool call, or a final answer. */
function scripted(steps: Array<{ tool: string; input: object } | { text: string }>) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doStream: (async () => {
      const step = steps[Math.min(n, steps.length - 1)]!;
      const id = `call_${n++}`;
      const body =
        "text" in step
          ? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: step.text }, { type: "text-end", id: "t" }]
          : [{ type: "tool-call", toolCallId: id, toolName: step.tool, input: JSON.stringify(step.input) }];
      const reason = "text" in step ? "stop" : "tool-calls";
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
          chunks: [{ type: "stream-start", warnings: [] }, ...body, { type: "finish", finishReason: { unified: reason, raw: reason }, usage }],
        }),
      };
    }) as never,
  });
}

describe("knowledgeTools in a turn", () => {
  it("reads and writes as the principal of the run, on the same Postgres as the chats", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    const db = drizzle(pg, { schema: pgSchema });
    await migratePostgres(db);

    const knowledge = createKnowledge<P>({
      db: fromPGlite(pg),
      access: (p) => ({ subjects: [`user:${p.org}/${p.user}`, `org:${p.org}`], mounts: { org: `org:${p.org}`, me: `user:${p.org}/${p.user}` } }),
    });
    await knowledge.migrate();
    for (const org of ["acme", "beta"]) {
      await knowledge.createSpace({ id: `org:${org}`, owner: [org], kind: "org" });
      await knowledge.grant({ space: `org:${org}`, subject: `org:${org}`, role: "editor", grantedBy: "setup" });
    }
    await knowledge.createSpace({ id: "user:acme/u1", owner: ["acme", "u1"], kind: "user" });
    await knowledge.grant({ space: "user:acme/u1", subject: "user:acme/u1", role: "editor", grantedBy: "setup" });
    await knowledge.as({ org: "acme", user: "u1" }).write("/org/docs/stack.md", "Acme runs Postgres 16.");
    await knowledge.as({ org: "beta", user: "u9" }).write("/org/docs/stack.md", "Beta runs MySQL.");

    const model = scripted([
      { tool: "read_file", input: { path: "/org/docs/stack.md" } },
      { tool: "write_file", input: { path: "/me/notes.md", content: "Acme is on Postgres 16." } },
      { text: "Noted." },
    ]);
    const runtime = createRuntime<P>({
      storage: createPostgresAdapter<P>(db, { owner: (p) => [p.org, p.user] }),
      agents: { expert: defineAgent<P>({ model, instructions: "Use the knowledge.", tools: knowledgeTools(knowledge) }) },
    });

    const result = await runtime.runAgent({ principal: { org: "acme", user: "u1" }, agent: "expert", prompt: "What do we run?" });
    expect(result.answer).toBe("Noted.");

    const toolResults = JSON.stringify(model.doStreamCalls.at(-1)!.prompt);
    expect(toolResults).toContain("Acme runs Postgres 16.");
    expect(toolResults).not.toContain("MySQL");
    expect(toolResults).toContain("Saved /me/notes.md, version 1");

    const { rows } = await pg.query<{ author: string; run_id: string }>(`select author, run_id from kb_versions v join kb_files f on f.id = v.file_id where f.path = 'notes.md'`);
    expect(rows).toEqual([{ author: "user:acme/u1", run_id: expect.stringMatching(/./) }]);

    // A customer's knowledge goes with their chats.
    const purged = await runtime.purgeOwner(["acme"], { usage: "delete", also: { knowledge } });
    expect(purged.removed.knowledge).toEqual({ spaces: 2, files: 2 });
    expect((await knowledge.as({ org: "beta", user: "u9" }).read("/org/docs/stack.md")).lines).toEqual(["Beta runs MySQL."]);
    await pg.close();
  });

  it("works on the AI SDK alone, bound to one person's view, with no context to pass", async () => {
    const pg = new PGlite({ extensions: { pg_trgm } });
    const knowledge = createKnowledge<P>({
      db: fromPGlite(pg),
      access: (p) => ({ subjects: [`user:${p.org}/${p.user}`], mounts: { me: `user:${p.org}/${p.user}` } }),
    });
    await knowledge.migrate();
    await knowledge.createSpace({ id: "user:acme/u1", owner: ["acme", "u1"], kind: "user" });
    await knowledge.grant({ space: "user:acme/u1", subject: "user:acme/u1", role: "editor", grantedBy: "setup" });

    const model = scripted([
      { tool: "write_file", input: { path: "/me/notes.md", content: "Prefers short answers." } },
      { tool: "read_file", input: { path: "/me/notes.md" } },
      { text: "Done." },
    ]);
    const result = streamText({
      model,
      prompt: "Remember that I prefer short answers.",
      tools: knowledgeTools(knowledge.as({ org: "acme", user: "u1" })),
      stopWhen: stepCountIs(5),
    });
    expect(await result.text).toBe("Done.");

    const toolResults = JSON.stringify(model.doStreamCalls.at(-1)!.prompt);
    expect(toolResults).toContain("Saved /me/notes.md, version 1");
    expect(toolResults).toContain("Prefers short answers.");
    await pg.close();
  });
});
