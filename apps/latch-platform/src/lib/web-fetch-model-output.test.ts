import { describe, expect, it } from "vitest";
import { webFetchToModelOutput } from "@/lib/sandbox/tools";

describe("webFetchToModelOutput", () => {
  it("turns fetched media into a file block the model can see, with a text anchor", () => {
    const output = {
      ok: true,
      kind: "media",
      status: 200,
      contentType: "image/png",
      mediaType: "image/png",
      data: "aGVsbG8=",
      bytes: 5,
      url: "https://example.com/logo.png",
    };
    expect(webFetchToModelOutput({ output })).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Fetched image/png (0 KB) from https://example.com/logo.png:" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "aGVsbG8=" } },
      ],
    });
  });

  it("keeps text results as plain JSON", () => {
    const output = { ok: true, status: 200, contentType: "text/html", body: "# Hi", truncated: false };
    expect(webFetchToModelOutput({ output })).toEqual({ type: "json", value: output });
  });

  it("keeps errors as plain JSON", () => {
    const output = { ok: false, error: "Host is not allowed." };
    expect(webFetchToModelOutput({ output })).toEqual({ type: "json", value: output });
  });
});
