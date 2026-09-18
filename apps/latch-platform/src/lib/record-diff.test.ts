import { describe, expect, it } from "vitest";
import { diffRecords } from "./record-diff";
import type { AgentRecord } from "@/lib/agent-store";

const rec = (over: Partial<AgentRecord> = {}): Partial<AgentRecord> => ({
  name: "helper",
  modelId: "m-1",
  instructions: "one\ntwo\nthree",
  connections: [],
  scope: "user",
  ...over,
});

describe("diffRecords", () => {
  it("reports nothing for identical records", () => {
    const d = diffRecords(rec(), rec());
    expect(d.identical).toBe(true);
    expect(d.instructions).toEqual([]);
    expect(d.fields).toEqual([]);
  });

  it("keeps unchanged prompt lines as context and marks the edit", () => {
    const d = diffRecords(rec(), rec({ instructions: "one\ntwo and a half\nthree" }));
    expect(d.identical).toBe(false);
    expect(d.instructions).toEqual([
      { kind: "same", text: "one" },
      { kind: "removed", text: "two" },
      { kind: "added", text: "two and a half" },
      { kind: "same", text: "three" },
    ]);
  });

  it("shows an insertion as added only, without rewriting the lines around it", () => {
    const d = diffRecords(rec(), rec({ instructions: "one\ntwo\nextra\nthree" }));
    expect(d.instructions.filter((l) => l.kind !== "same")).toEqual([
      { kind: "added", text: "extra" },
    ]);
  });

  // Identical head/tail lines are peeled off before the quadratic part, so the
  // boundaries are where an off-by-one would hide.
  it("handles a change on the very first line", () => {
    const d = diffRecords(rec(), rec({ instructions: "ONE\ntwo\nthree" }));
    expect(d.instructions).toEqual([
      { kind: "removed", text: "one" },
      { kind: "added", text: "ONE" },
      { kind: "same", text: "two" },
      { kind: "same", text: "three" },
    ]);
  });

  it("handles a change on the very last line", () => {
    const d = diffRecords(rec(), rec({ instructions: "one\ntwo\nTHREE" }));
    expect(d.instructions).toEqual([
      { kind: "same", text: "one" },
      { kind: "same", text: "two" },
      { kind: "removed", text: "three" },
      { kind: "added", text: "THREE" },
    ]);
  });

  it("keeps a long prompt's untouched lines intact around a one-line edit", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const edited = [...lines];
    edited[200] = "line 200 (edited)";
    const d = diffRecords(
      rec({ instructions: lines.join("\n") }),
      rec({ instructions: edited.join("\n") }),
    );
    expect(d.instructions.filter((l) => l.kind !== "same")).toEqual([
      { kind: "removed", text: "line 200" },
      { kind: "added", text: "line 200 (edited)" },
    ]);
    // Every other line survives as context, in order.
    expect(d.instructions.filter((l) => l.kind === "same")).toHaveLength(399);
    expect(d.instructions[0]).toEqual({ kind: "same", text: "line 0" });
    expect(d.instructions.at(-1)).toEqual({ kind: "same", text: "line 399" });
  });

  it("handles a prompt written from empty", () => {
    const d = diffRecords(rec({ instructions: "" }), rec({ instructions: "hello" }));
    expect(d.instructions).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "hello" },
    ]);
  });

  it("lists non-prompt changes as before/after rather than line diffs", () => {
    const d = diffRecords(rec(), rec({ modelId: "m-2", subagents: ["a", "b"] }));
    expect(d.instructions).toEqual([]);
    expect(d.fields).toEqual([
      { field: "modelId", before: "m-1", after: "m-2" },
      { field: "subagents", before: undefined, after: "a, b" },
    ]);
  });

  it("orders fields to read like the editor, not alphabetically", () => {
    const d = diffRecords(rec(), rec({ maxSteps: 5, title: "T", modelId: "m-2" }));
    expect(d.fields.map((f) => f.field)).toEqual(["title", "modelId", "maxSteps"]);
  });

  it("treats an emptied value as absent, so [] and undefined are not a change", () => {
    const d = diffRecords(rec({ connections: [] }), rec({ connections: undefined }));
    expect(d.fields).toEqual([]);
  });

  it("has nothing to diff against on the first version", () => {
    expect(diffRecords(undefined, rec()).identical).toBe(true);
  });
});
