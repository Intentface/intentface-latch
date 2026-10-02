import { describe, expect, it } from "vitest";
import { runUnit } from "./runner";

describe("an input's files", () => {
  it("send a text file as text, named; a PDF as a file", async () => {
    const { withFiles } = await import("./runner");
    const out = withFiles({
      prompt: "What do we owe?",
      files: [
        { filename: "note.txt", mediaType: "text/plain", url: `data:text/plain;base64,${btoa("Total: 4210")}`, size: 11 },
        { filename: "invoice.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=", size: 5 },
      ],
    });
    expect(out.prompt).toBe('<file name="note.txt">\nTotal: 4210\n</file>\n\nWhat do we owe?');
    expect(out.files.map((f) => f.filename)).toEqual(["invoice.pdf"]);
  });

  it("go with the first message, not with the follow-ups", async () => {
    const calls: { prompt: string; files?: unknown[] }[] = [];
    await runUnit({
      owner: "o",
      dataset: { id: "ds", agentName: "bot" },
      runId: "r",
      v: { label: "live", ref: "bot", fingerprint: "A" },
      attempt: 0,
      input: {
        id: "1",
        prompt: "What does this invoice say we owe?",
        followUps: ["Can we pay it in two parts?"],
        files: [{ filename: "invoice.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=", size: 5 }],
      },
      deps: {
        runAgent: (i) => {
          calls.push({ prompt: i.prompt, ...(i.files ? { files: i.files } : {}) });
          return Promise.resolve({ threadId: "t", answer: "ok" });
        },
      },
    });
    expect(calls).toEqual([
      { prompt: "What does this invoice say we owe?", files: [{ url: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf", filename: "invoice.pdf" }] },
      { prompt: "Can we pay it in two parts?" },
    ]);
  });
});
