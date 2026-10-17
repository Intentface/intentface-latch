import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "./migrate.js";
import { createSqliteAgentBuilderStore } from "./agent-store.js";

/** A real run against an in-memory libsql DB: record round-trip + scope isolation + resolve. */
type P = { orgId: string; userId: string };

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
};

async function main() {
  const p: P = { orgId: "o1", userId: "u1" };
  const p2: P = { orgId: "o1", userId: "u2" };

  const client = createClient({ url: ":memory:" });
  await migrate(client);
  const store = createSqliteAgentBuilderStore<P>(drizzle(client), {
    owner: (pr, scope) => (scope === "org" ? [pr.orgId] : [pr.orgId, pr.userId]),
    modelFor: (id) => ({ modelId: id }) as never,
  });

  await store.upsert(p, {
    name: "helper",
    modelId: "m-1",
    instructions: "help",
    connections: ["github"],
    maxSteps: "unlimited",
    exec: { sandbox: true, effort: "low", memory: { scope: "agent-user", connection: "github" } },
    subagents: ["assistant"],
    scope: "user",
  });
  await store.upsert(p, {
    name: "shared",
    modelId: "m-2",
    instructions: "org agent",
    connections: [],
    scope: "org",
  });

  // list: personal + org visible; another org member sees only org
  assert((await store.list(p)).length === 2, "creator sees both");
  const other = await store.list(p2);
  assert(other.length === 1 && other[0]!.name === "shared", "other member sees org only");

  // record fields round-trip
  const recs = await store.listRecords(p);
  const helper = recs.find((r) => r.name === "helper")!;
  assert(helper.maxSteps === "unlimited", "maxSteps unlimited round-trips");
  assert(helper.exec?.sandbox === true && helper.exec?.effort === "low", "exec round-trips");
  assert(Array.isArray(helper.connections) && helper.connections[0] === "github", "connections round-trip");
  assert(helper.exec?.memory?.connection === "github", "exec.memory round-trips");

  // getRecord: bare name (personal wins), org: pin, user: pin miss
  assert((await store.getRecord(p, "helper"))?.modelId === "m-1", "getRecord bare name");
  assert((await store.getRecord(p2, "org:shared"))?.name === "shared", "getRecord org: pin");
  assert(!(await store.getRecord(p2, "user:shared")), "getRecord user: pin misses org record");

  // listMemoryEnabledNames: cross-tenant prefilter by exec JSON
  const memNames = await store.listMemoryEnabledNames();
  assert(memNames.includes("helper") && !memNames.includes("shared"), "listMemoryEnabledNames prefilter");

  // resolve builds AgentConfig; scope pinning works
  const cfg = await store.resolve("helper", p);
  assert(cfg && cfg.instructions === "help" && cfg.maxSteps === "unlimited", "resolve builds config");
  assert(cfg!.memory?.scope === "agent-user", "resolve carries exec.memory");
  assert((cfg!.model as { modelId: string }).modelId === "m-1", "modelFor applied");
  assert(cfg!.subagents?.[0] === "assistant", "subagents resolve");
  assert(await store.resolve("org:shared", p2), "org: pin resolves");
  assert(!(await store.resolve("user:shared", p2)), "user: pin misses org record");

  // upsert-by-name updates, not duplicates
  await store.upsert(p, { name: "helper", modelId: "m-2", instructions: "help v2", connections: [], scope: "user" });
  const after = await store.listRecords(p);
  assert(after.filter((r) => r.name === "helper").length === 1, "upsert dedupes");
  assert(after.find((r) => r.name === "helper")!.modelId === "m-2", "upsert updates");

  // remove
  await store.remove(p, "user", "helper");
  assert(!(await store.resolve("helper", p)), "removed record no longer resolves");

  console.log("agent-store smoke: ALL PASS");
}

main().catch((e) => {
  console.error("❌ agent-store smoke failed:", e);
  throw e; // unhandled rejection → non-zero exit (no @types/node dep here)
});
