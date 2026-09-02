import { describe, expect, it } from "vitest";
import { appTools, defaultHarnessTools, harnessContextOf, sandboxTools, tail } from "./tools.js";

/**
 * The harness tools that run in the app process, driven with the context the
 * runtime supplies (`options.context`: principal + runtime) — no host-global.
 */

type Exec = { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> };
const principal = { orgId: "org_a" };

function fakeRuntime(schedules: { id: string; agent: string; cron: string | null; prompt: string; nextRunAt: number; enabled: boolean }[]) {
  const removed: string[] = [];
  return {
    removed,
    runtime: {
      listSchedules: async () => schedules,
      unschedule: async ({ id }: { id: string }) => void removed.push(id),
    },
  };
}

describe("defaultHarnessTools", () => {
  it("bundles sandbox + app tools with no default gates, as fresh objects", () => {
    const a = defaultHarnessTools();
    const b = defaultHarnessTools();
    expect(Object.keys(a.sandbox).sort()).toEqual(["bash", "glob", "grep", "read_file", "write_file"]);
    expect(Object.keys(a.app).sort()).toEqual(["askUser", "cancel_schedule", "list_schedules", "web_fetch"]);
    expect(a.approval).toEqual({});
    expect(a.app).not.toBe(b.app); // a host may spread its own tools in without touching the module
    expect(a.sandbox.bash).toBe(sandboxTools.bash);
  });

  it("askUser is client-handled (no execute)", () => {
    expect((appTools.askUser as { execute?: unknown }).execute).toBeUndefined();
  });
});

describe("schedule tools over options.context.runtime", () => {
  const rows = [{ id: "sch_1", agent: "digest", cron: "0 8 * * *", prompt: "brief", nextRunAt: 0, enabled: true }];

  it("list_schedules reads the caller's schedules from the turn's runtime", async () => {
    const { runtime } = fakeRuntime(rows);
    const out = await (appTools.list_schedules as Exec).execute({}, { context: { principal, runtime } });
    expect(out.schedules).toEqual([
      { id: "sch_1", agent: "digest", cron: "0 8 * * *", timezone: "UTC", prompt: "brief", enabled: true, nextRunAt: new Date(0).toISOString() },
    ]);
  });

  it("cancel_schedule is truthful: unknown ids are refused, known ids are unscheduled", async () => {
    const { runtime, removed } = fakeRuntime(rows);
    const ctx = { context: { principal, runtime } };
    expect(await (appTools.cancel_schedule as Exec).execute({ id: "ghost" }, ctx)).toEqual({
      error: "No schedule ghost — call list_schedules for current ids.",
    });
    expect(await (appTools.cancel_schedule as Exec).execute({ id: "sch_1" }, ctx)).toEqual({ cancelled: "sch_1" });
    expect(removed).toEqual(["sch_1"]);
  });

  it("without a runtime on the context the tools fail closed", async () => {
    const out = await (appTools.list_schedules as Exec).execute({}, { context: { principal } });
    expect(out.error).toMatch(/No principal\/runtime/);
    expect(harnessContextOf({}).runtime).toBeUndefined();
  });
});

describe("sandbox tools", () => {
  const session = (stdout: string, exitCode = 0) => ({
    run: async () => ({ stdout, stderr: "", exitCode }),
    readTextFile: async ({ path }: { path: string }) => (path === "a.txt" ? "one\ntwo\nthree" : null),
    writeTextFile: async () => {},
  });

  it("read_file numbers lines from the requested start; missing file → found:false", async () => {
    const read = sandboxTools.read_file as Exec;
    const r = await read.execute({ path: "a.txt", start_line: 2 }, { experimental_sandbox: session("") });
    expect(r).toEqual({ found: true, content: "2\tone\n3\ttwo\n4\tthree" });
    expect(await read.execute({ path: "nope" }, { experimental_sandbox: session("") })).toEqual({ found: false });
  });

  it("grep treats rg's exit 1 as no matches, not an error; glob caps the list", async () => {
    const grep = sandboxTools.grep as Exec;
    expect(await grep.execute({ pattern: "x" }, { experimental_sandbox: session("", 1) })).toEqual({
      matches: "",
      truncated: false,
      noMatches: true,
    });
    const many = Array.from({ length: 600 }, (_, i) => `f${i}`).join("\n");
    const g = await (sandboxTools.glob as Exec).execute({ pattern: "*" }, { experimental_sandbox: session(many) });
    expect((g.files as string[]).length).toBe(500);
    expect(g.truncated).toBe(true);
  });

  it("tail keeps the end of long output", () => {
    const long = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const t = tail(long, 3);
    expect(t).toEqual({ text: "l497\nl498\nl499", truncated: true });
    expect(tail("short")).toEqual({ text: "short", truncated: false });
  });

  it("every sandbox tool refuses to run without a sandbox", async () => {
    await expect((sandboxTools.bash as Exec).execute({ command: "ls" }, {})).rejects.toThrow(/No sandbox/);
  });
});
