import { describe, expect, it } from "vitest";
import { verifyTelegramSecretToken } from "./verify.js";

describe("verifyTelegramSecretToken", () => {
  it("accepts a matching secret", () => {
    expect(verifyTelegramSecretToken("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyTelegramSecretToken("nope", "s3cret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyTelegramSecretToken(null, "s3cret")).toBe(false);
  });

  it("rejects when no secret is configured (never open-by-default)", () => {
    expect(verifyTelegramSecretToken("anything", "")).toBe(false);
  });

  it("rejects length mismatches without throwing", () => {
    expect(verifyTelegramSecretToken("s3cret-longer", "s3cret")).toBe(false);
  });
});
