import { describe, expect, it } from "vitest";
import { parseAgentRef } from "@intentface/latch-agent-builder";

describe("parseAgentRef with pins", () => {
  it("leaves a bare name alone", () => {
    expect(parseAgentRef("edge-v2")).toEqual({ name: "edge-v2" });
  });
  it("reads a published version", () => {
    expect(parseAgentRef("edge-v2@2")).toEqual({ name: "edge-v2", at: 2 });
  });
  it("reads the draft", () => {
    expect(parseAgentRef("edge-v2@draft")).toEqual({ name: "edge-v2", at: "draft" });
  });
  it("keeps scope and pin together", () => {
    expect(parseAgentRef("org:edge-v2@7")).toEqual({ name: "edge-v2", scope: "org", at: 7 });
  });
  it("does not treat an email-ish or unknown suffix as a pin", () => {
    expect(parseAgentRef("edge-v2@latest")).toEqual({ name: "edge-v2@latest" });
  });
});
