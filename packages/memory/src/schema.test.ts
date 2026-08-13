import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_SCHEMAS,
  MEMORY_POLICY_FLOOR,
  USER_SCHEMA_PATH,
  schemaFingerprint,
  schemaSections,
  schemaSectionWarnings,
  schemasFingerprint,
} from "./schema.js";

describe("schemaSections", () => {
  it("extracts top-level ## headings in order, ignoring deeper levels and bullets", () => {
    const schema = [
      "# Title",
      "## Runner profile",
      "- who they are",
      "### sub",
      "## Race goals",
      "  ## Indented counts too",
      "#### nope",
    ].join("\n");
    expect(schemaSections(schema)).toEqual(["Runner profile", "Race goals", "Indented counts too"]);
  });

  it("returns [] for outline-free text", () => {
    expect(schemaSections("just some prose\n- a bullet")).toEqual([]);
  });
});

describe("schemaFingerprint", () => {
  it("is stable across trailing whitespace and blank-line runs", () => {
    const a = schemaFingerprint("## A\n- x\n\n\n## B");
    const b = schemaFingerprint("## A  \n- x\n## B\n");
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    expect(schemaFingerprint("## A")).not.toBe(schemaFingerprint("## B"));
  });

  it('is "0" for undefined and blank schemas', () => {
    expect(schemaFingerprint(undefined)).toBe("0");
    expect(schemaFingerprint("   \n ")).toBe("0");
  });
});

describe("schemasFingerprint", () => {
  it("is order-independent over levels", () => {
    const a = schemasFingerprint([
      { level: "agent-user", schema: "## A" },
      { level: "agent-org", schema: "## B" },
    ]);
    const b = schemasFingerprint([
      { level: "agent-org", schema: "## B" },
      { level: "agent-user", schema: "## A" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a level is added or a schema edited", () => {
    const base = schemasFingerprint([{ level: "agent-user", schema: "## A" }]);
    expect(
      schemasFingerprint([
        { level: "agent-user", schema: "## A" },
        { level: "user", schema: undefined },
      ]),
    ).not.toBe(base);
    expect(schemasFingerprint([{ level: "agent-user", schema: "## A2" }])).not.toBe(base);
  });
});

describe("schemaSectionWarnings", () => {
  const SCHEMA = "## Runner profile\n- desc\n## Race goals";

  it("flags sections outside the outline, naming the allowed ones", () => {
    const warnings = schemaSectionWarnings(SCHEMA, "## Coffee habits\n- [m-aaaaaa] x");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"## Coffee habits"');
    expect(warnings[0]).toContain("## Runner profile, ## Race goals");
  });

  it("allows schema sections and Archive, case-insensitively", () => {
    const content = "## runner PROFILE\n## Race goals\n## ARCHIVE\n";
    expect(schemaSectionWarnings(SCHEMA, content)).toEqual([]);
  });

  it("an outline-free schema constrains nothing", () => {
    expect(schemaSectionWarnings("free-form guidance only", "## Anything")).toEqual([]);
  });
});

describe("constants", () => {
  it("USER_SCHEMA_PATH is the shared (non-private-root) workspace file", () => {
    expect(USER_SCHEMA_PATH).toBe("__shared_root/_memory/_user/SCHEMA.md");
    expect(USER_SCHEMA_PATH.startsWith("__private_root")).toBe(false);
  });

  it("every scope has a policy floor and a default schema with an outline", () => {
    for (const scope of ["agent-user", "agent-org", "user"] as const) {
      expect(MEMORY_POLICY_FLOOR[scope].length).toBeGreaterThan(20);
      expect(schemaSections(DEFAULT_MEMORY_SCHEMAS[scope]).length).toBeGreaterThan(1);
    }
  });
});
