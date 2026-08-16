import { describe, expect, it } from "vitest";
import { withStructuredContentFallback } from "./host.js";

const call = (output: unknown, original?: (args: never) => unknown) =>
  withStructuredContentFallback(original)({ toolCallId: "c1", input: {}, output });

describe("withStructuredContentFallback", () => {
  it("returns structuredContent as JSON when content is empty (Airtable-style)", () => {
    const output = {
      content: [],
      structuredContent: { bases: [{ id: "app1", name: "ATS" }] },
      isError: false,
    };
    expect(call(output)).toEqual({
      type: "json",
      value: { bases: [{ id: "app1", name: "ATS" }] },
    });
  });

  it("falls back when content only holds blank text parts", () => {
    const output = {
      content: [{ type: "text", text: "  " }],
      structuredContent: { ok: true },
    };
    expect(call(output)).toEqual({ type: "json", value: { ok: true } });
  });

  it("keeps the SDK mapping when content carries real text", () => {
    const output = {
      content: [{ type: "text", text: "3 bases found" }],
      structuredContent: { bases: [] },
    };
    const original = () => ({ type: "content", value: [{ type: "text", text: "3 bases found" }] });
    expect(call(output, original)).toEqual({
      type: "content",
      value: [{ type: "text", text: "3 bases found" }],
    });
  });

  it("keeps the SDK mapping for non-text parts (images)", () => {
    const output = {
      content: [{ type: "image", data: "…", mimeType: "image/png" }],
      structuredContent: { alt: "chart" },
    };
    const original = () => "sdk";
    expect(call(output, original)).toBe("sdk");
  });

  it("leaves errors alone even with structuredContent present", () => {
    const output = { content: [], structuredContent: { reason: "x" }, isError: true };
    const original = () => "sdk-error-path";
    expect(call(output, original)).toBe("sdk-error-path");
  });

  it("passes plain results through as JSON when no original mapper exists", () => {
    expect(call({ anything: 1 })).toEqual({ type: "json", value: { anything: 1 } });
  });
});
