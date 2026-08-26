import { describe, expect, it } from "vitest";
import {
  mcpApprovalValue,
  needsMcpApproval,
  nameHeuristicApproval,
  type McpToolInfo,
} from "./index.js";

/**
 * The approval policy's two-level shape: a policy decides per TOOL (from its
 * descriptor/annotations), and may hand back a per-CALL function that decides
 * from the model's arguments. The call form exists for meta-tool servers —
 * one `execute_tool` multiplexing every operation carries a single annotation
 * set, so a per-tool boolean can only gate everything or nothing.
 */

const READ_TOOL: McpToolInfo = {
  name: "find_many_companies",
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL: McpToolInfo = {
  name: "create_company",
  annotations: { destructiveHint: true },
};
const META_TOOL: McpToolInfo = { name: "execute_tool" };

describe("needsMcpApproval", () => {
  it('"destructive" (default) keys on annotations', () => {
    expect(needsMcpApproval(undefined, READ_TOOL)).toBe(false);
    expect(needsMcpApproval(undefined, WRITE_TOOL)).toBe(true);
    expect(needsMcpApproval("destructive", META_TOOL)).toBe(false); // no hints
  });

  it("passes a per-call function through from the predicate", () => {
    const perCall = (input: unknown) =>
      String((input as { toolName?: string })?.toolName ?? "").startsWith("create_");
    const gate = needsMcpApproval(
      (tool) => (tool.name === "execute_tool" ? perCall : false),
      META_TOOL,
    );
    expect(gate).toBe(perCall);
  });
});

describe("mcpApprovalValue — the SDK toolApproval map value", () => {
  it("boolean policies map to 'user-approval' / undefined", () => {
    expect(mcpApprovalValue("all", READ_TOOL)).toBe("user-approval");
    expect(mcpApprovalValue("none", WRITE_TOOL)).toBeUndefined();
    expect(mcpApprovalValue(undefined, WRITE_TOOL)).toBe("user-approval");
    expect(mcpApprovalValue(undefined, READ_TOOL)).toBeUndefined();
  });

  it("a per-call policy gates by ARGUMENTS at call time", async () => {
    const value = mcpApprovalValue(
      (tool) =>
        tool.name === "execute_tool"
          ? (input) =>
              /^(create|update|delete)_/.test(
                String((input as { toolName?: string })?.toolName ?? ""),
              )
          : false,
      META_TOOL,
    );
    expect(typeof value).toBe("function");
    const decide = value as (input: unknown) => Promise<"user-approval" | undefined>;
    // The read that finding 1.2 saw gated — through the meta-tool — runs free…
    expect(await decide({ toolName: "find_many_companies" })).toBeUndefined();
    // …while the mutating operations still stop for a human.
    expect(await decide({ toolName: "create_person" })).toBe("user-approval");
    expect(await decide({ toolName: "delete_company" })).toBe("user-approval");
  });

  it("supports an async per-call decision", async () => {
    const value = mcpApprovalValue(() => async () => true, META_TOOL);
    const decide = value as (input: unknown) => Promise<"user-approval" | undefined>;
    expect(await decide({})).toBe("user-approval");
  });
});

describe("nameHeuristicApproval (unchanged behavior)", () => {
  it("annotations stay authoritative; verb heuristic only without hints", () => {
    const policy = nameHeuristicApproval();
    expect(policy(READ_TOOL)).toBe(false); // readOnlyHint wins
    expect(policy({ name: "create_deal" })).toBe(true); // verb, no hints
    expect(policy({ name: "list_deals" })).toBe(false);
  });
});
