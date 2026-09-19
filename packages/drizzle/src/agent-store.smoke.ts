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
    attachedEvals: [{ name: "on-topic", prompt: "Stays on topic.", scale: "binary", enabled: true }],
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
  assert(helper.attachedEvals?.[0]?.name === "on-topic", "attachedEvals round-trip");
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

  // Pinned configurations: `@<version>` and `@draft` resolve a DIFFERENT
  // config of the same agent without making it live. This is what lets an
  // eval measure a version — activating each in turn to compare them would
  // move real traffic between them mid-comparison.
  await store.upsert(p, { name: "pinned", modelId: "m-1", instructions: "v1", connections: [], scope: "user" });
  await store.upsert(p, { name: "pinned", modelId: "m-2", instructions: "v2", connections: [], scope: "user" });
  const versions = await store.listVersions(p, "pinned", "user");
  assert(versions.length === 2, `two versions recorded (got ${versions.length})`);

  const livePin = await store.resolve("pinned", p);
  assert(livePin?.instructions === "v2", "bare name resolves the LIVE config");
  const v1 = await store.resolve("pinned@1", p);
  assert(v1?.instructions === "v1", `@1 resolves version 1 (got ${String(v1?.instructions)})`);
  const stillLive = await store.resolve("pinned", p);
  assert(stillLive?.instructions === "v2", "resolving a version did not make it live");

  await store.saveDraft(p, "pinned", "user", { name: "pinned", modelId: "m-3", instructions: "draft only", connections: [], scope: "user" }, 2);
  const draft = await store.resolve("pinned@draft", p);
  assert(draft?.instructions === "draft only", "@draft resolves the unpublished edit");
  assert((await store.resolve("pinned", p))?.instructions === "v2", "a draft never affects the live agent");

  assert(!(await store.resolve("pinned@99", p)), "an unknown version resolves to nothing");
  assert(!(await store.resolve("absent@1", p)), "a pin cannot resolve an agent you cannot see");
  assert((await store.resolve("user:pinned@1", p))?.instructions === "v1", "scope + version pin together");

  // remove
  await store.remove(p, "user", "helper");
  assert(!(await store.resolve("helper", p)), "removed record no longer resolves");

  console.log("agent-store smoke: ALL PASS");
}

main().catch((e) => {
  console.error("❌ agent-store smoke failed:", e);
  throw e; // unhandled rejection → non-zero exit (no @types/node dep here)
});
