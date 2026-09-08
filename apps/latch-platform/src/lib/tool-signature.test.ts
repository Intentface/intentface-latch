import { describe, expect, it } from "vitest";
import { paramsOf, parseSchema, signatureOf, snippetOf, typeOf } from "./tool-signature";

const schema = JSON.stringify({
  type: "object",
  properties: {
    period: { type: "string", description: "e.g. this-week" },
    limit: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    mode: { enum: ["fast", "full"] },
    who: { anyOf: [{ type: "string" }, { type: "null" }] },
    where: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  required: ["period", "where"],
});

describe("tool signatures from JSON Schema", () => {
  it("renders a TS-ish signature with optional markers", () => {
    expect(signatureOf("clockify_hours", parseSchema(schema))).toBe(
      "clockify_hours({ period: string, limit?: integer, tags?: string[], mode?: \"fast\" | \"full\", who?: string | null, where: { city: string } })",
    );
    expect(signatureOf("ping", parseSchema('{"type":"object"}'))).toBe("ping({})");
    expect(signatureOf("ping", undefined)).toBe("ping({})");
  });

  it("lists params with descriptions and builds a snippet from the required ones", () => {
    const params = paramsOf(parseSchema(schema));
    expect(params.map((p) => [p.name, p.required])).toEqual([
      ["period", true], ["limit", false], ["tags", false], ["mode", false], ["who", false], ["where", true],
    ]);
    expect(params[0]!.description).toBe("e.g. this-week");
    expect(snippetOf("clockify_hours", parseSchema(schema))).toBe(
      "await clockify_hours({ period: ${period}, where: ${where} })",
    );
    expect(snippetOf("ping", undefined)).toBe("await ping({})");
  });

  it("tolerates junk", () => {
    expect(parseSchema("not json")).toBeUndefined();
    expect(parseSchema(undefined)).toBeUndefined();
    expect(typeOf(undefined)).toBe("unknown");
  });
});
