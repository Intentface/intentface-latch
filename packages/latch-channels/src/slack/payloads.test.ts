import { describe, expect, it } from "vitest";
import { decodeAction, encodeAction } from "./payloads.js";

const SECRET = "test-signing-secret";
const NOW = 1_755_000_000_000;

const base = {
  kind: "approval" as const,
  chatId: "slack2_A1_C1_1.2",
  approvalId: "appr_1",
  tool: "edit_file",
  actor: "U0ALICE",
};

describe("signed action payloads", () => {
  it("round-trips", () => {
    const value = encodeAction(base, SECRET, NOW);
    const decoded = decodeAction(value, SECRET, NOW);
    expect(decoded).toMatchObject({ ...base, v: 2 });
    expect(decoded?.exp).toBe(Math.floor(NOW / 1000) + 7 * 24 * 3600);
  });

  it("rejects a tampered payload", () => {
    const value = encodeAction(base, SECRET, NOW);
    const [body, sig] = value.split(".") as [string, string];
    // Flip the actor inside the JSON body, keep the old signature.
    const json = JSON.parse(Buffer.from(body, "base64url").toString());
    json.actor = "U0MALLORY";
    const forged = `${Buffer.from(JSON.stringify(json)).toString("base64url")}.${sig}`;
    expect(decodeAction(forged, SECRET, NOW)).toBeNull();
  });

  it("rejects a foreign app's signature (per-app key derivation)", () => {
    const value = encodeAction(base, SECRET, NOW);
    expect(decodeAction(value, "other-apps-secret", NOW)).toBeNull();
  });

  it("expires", () => {
    const value = encodeAction(base, SECRET, NOW);
    const after = NOW + 8 * 24 * 3600 * 1000;
    expect(decodeAction(value, SECRET, after)).toBeNull();
    expect(decodeAction(value, SECRET, NOW + 1000)).not.toBeNull();
  });

  it("rejects garbage without throwing", () => {
    expect(decodeAction("", SECRET, NOW)).toBeNull();
    expect(decodeAction("no-dot-here", SECRET, NOW)).toBeNull();
    expect(decodeAction("a.b", SECRET, NOW)).toBeNull();
    expect(decodeAction("###.###", SECRET, NOW)).toBeNull();
  });

  it("enforces Slack's 2000-char button value cap", () => {
    expect(() =>
      encodeAction({ ...base, tool: "x".repeat(3000) }, SECRET, NOW),
    ).toThrow(/too large/);
  });
});
