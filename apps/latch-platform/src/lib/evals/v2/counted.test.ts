import { describe, expect, it } from "vitest";
import { describeCounted, evaluateCounted, globToRegExp, readPath } from "./counted";
import { viewOf } from "./thread";

const tool = (toolName: string, input: unknown, output: unknown = { ok: true }, extra: object = {}) => ({
  type: "dynamic-tool",
  toolName,
  input,
  output,
  state: "output-available",
  ...extra,
});

/** A Linear-shaped thread: look, then act, then answer. */
const linear = viewOf([
  { role: "user", parts: [{ type: "text", text: "Close the duplicate of ABC-12" }] },
  {
    role: "assistant",
    parts: [
      { type: "text", text: "Let me look." },
      tool("linear_get_issue", { id: "ABC-12" }),
      tool("linear_search", { q: "duplicate" }),
      tool("linear_search", { q: "duplicate" }),
      tool("linear_update_issue", { id: "ABC-13", state: "Done" }, { __stubbed: true, ok: true }),
      { type: "text", text: "Closed ABC-13 as a duplicate." },
    ],
  },
]);

/** A knowledge-shaped thread: the name only appears in the RESULT. */
const kn = viewOf([
  { role: "user", parts: [{ type: "text", text: "Which accessibility standard?" }] },
  {
    role: "assistant",
    parts: [
      tool("kn_read_file", { fileIds: ["file_5eyjf"] }, { files: [{ id: "file_5eyjf", name: "accessibility.md" }] }),
      { type: "text", text: "WCAG 2.1 AA." },
    ],
  },
]);

describe("globs", () => {
  it("matches families of tools", () => {
    expect(globToRegExp("linear_*").test("linear_update_issue")).toBe(true);
    expect(globToRegExp("*_read_file").test("kn_read_file")).toBe(true);
    expect(globToRegExp("linear_get_issue").test("linear_get_issues")).toBe(false);
  });
});

describe("readPath", () => {
  it("reads args by default, result on request, with array indices", () => {
    const c = kn.calls[0]!;
    expect(readPath(c, "fileIds[0]")).toBe("file_5eyjf");
    expect(readPath(c, "args.fileIds[0]")).toBe("file_5eyjf");
    expect(readPath(c, "result.files[0].name")).toBe("accessibility.md");
    expect(readPath(c, "result.nope.deeper")).toBeUndefined();
  });
});

describe("the nine operators", () => {
  it("called / never called, over a glob", () => {
    expect(evaluateCounted({ op: "called", tool: "linear_update_issue" }, linear).passed).toBe(true);
    expect(evaluateCounted({ op: "never_called", tool: "linear_delete_*" }, linear).passed).toBe(true);
    expect(evaluateCounted({ op: "never_called", tool: "linear_*" }, linear).passed).toBe(false);
  });

  it("called with — on args", () => {
    expect(
      evaluateCounted({ op: "called_with", tool: "linear_update_issue", path: "state", match: { equals: "Done" } }, linear).passed,
    ).toBe(true);
    expect(
      evaluateCounted({ op: "called_with", tool: "linear_update_issue", path: "id", match: { equals: "ABC-12" } }, linear).passed,
    ).toBe(false);
    expect(
      evaluateCounted({ op: "called_with", tool: "linear_update_issue", path: "id", match: { matches: "^ABC-\\d+$" } }, linear).passed,
    ).toBe(true);
    expect(
      evaluateCounted({ op: "called_with", tool: "linear_update_issue", path: "state", match: { oneOf: ["Done", "Canceled"] } }, linear)
        .passed,
    ).toBe(true);
  });

  it("called with — on the result, which is where Loredex names the file", () => {
    expect(
      evaluateCounted({ op: "called_with", tool: "*_read_file", path: "result", match: { contains: "accessibility.md" } }, kn).passed,
    ).toBe(true);
  });

  it("at least / at most", () => {
    expect(evaluateCounted({ op: "at_least", tool: "linear_search", n: 2 }, linear).passed).toBe(true);
    expect(evaluateCounted({ op: "at_most", tool: "linear_*", n: 3 }, linear).passed).toBe(false);
  });

  it("repeated — passes only when nothing was called twice with identical args", () => {
    expect(evaluateCounted({ op: "repeated", tool: "linear_search" }, linear).passed).toBe(false);
    expect(evaluateCounted({ op: "repeated", tool: "linear_get_issue" }, linear).passed).toBe(true);
  });

  it("before — look before you act", () => {
    expect(evaluateCounted({ op: "before", tool: "linear_get_issue", then: "linear_update_issue" }, linear).passed).toBe(true);
    expect(evaluateCounted({ op: "before", tool: "linear_update_issue", then: "linear_get_issue" }, linear).passed).toBe(false);
    // Nothing to precede: the rule was never tested, so it did not fail.
    expect(evaluateCounted({ op: "before", tool: "linear_get_issue", then: "linear_delete_issue" }, linear).passed).toBe(true);
  });

  it("before answering — a preamble is not the answer", () => {
    // "Let me look." comes before the tool calls; the answer is the final text.
    expect(evaluateCounted({ op: "before_answering", tool: "linear_get_issue" }, linear).passed).toBe(true);
    const spokeFirst = viewOf([
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "The answer is 25." }, tool("kn_read_file", { id: 1 })] },
    ]);
    expect(evaluateCounted({ op: "before_answering", tool: "kn_read_file" }, spokeFirst).passed).toBe(false);
  });

  it("stopped for approval — reads the runtime's gating, not a guess", () => {
    expect(evaluateCounted({ op: "stopped_for_approval", tool: "linear_update_issue" }, linear).passed).toBe(true);
    expect(evaluateCounted({ op: "stopped_for_approval", tool: "linear_get_issue" }, linear).passed).toBe(false);
  });
});

describe("describeCounted", () => {
  it("renders every check as a sentence the grid can show", () => {
    expect(
      describeCounted({
        kind: "counted",
        id: "x",
        label: "x",
        spec: { op: "called_with", tool: "linear_update_issue", path: "state", match: { equals: "Done" } },
      }),
    ).toBe('linear_update_issue was called where state equals "Done"');
  });
});

describe("per-input values", () => {
  it("fills {{facts.x}} from the input, and a list must be fully satisfied", async () => {
    const { evaluateBound } = await import("./counted");
    const spec = { op: "called_with" as const, tool: "*_read_file", path: "result", match: { contains: "{{facts.docs}}" } };
    expect(evaluateBound(spec, kn, { docs: ["accessibility.md"] })!.passed).toBe(true);
    const both = evaluateBound(spec, kn, { docs: ["accessibility.md", "facets.md"] })!;
    expect(both).toEqual({ passed: false, detail: "1 of 2 satisfied" });
  });

  it("is not applicable when the input does not say", async () => {
    const { evaluateBound } = await import("./counted");
    const spec = { op: "called_with" as const, tool: "linear_update_issue", path: "id", match: { equals: "{{facts.issueId}}" } };
    expect(evaluateBound(spec, linear, {})).toBeNull();
    expect(evaluateBound(spec, linear, { issueId: "ABC-13" })!.passed).toBe(true);
  });
});
