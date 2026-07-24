import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWhatsappSignature, whatsappVerifyChallenge } from "./verify.js";

describe("whatsappVerifyChallenge", () => {
  const url = (qs: string) => new URL(`https://x.example/api/whatsapp/b1/events?${qs}`);

  it("echoes the challenge for a matching verify token", () => {
    expect(
      whatsappVerifyChallenge(
        url("hub.mode=subscribe&hub.verify_token=vt&hub.challenge=ping-123"),
        "vt",
      ),
    ).toBe("ping-123");
  });

  it("rejects a wrong verify token", () => {
    expect(
      whatsappVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=NO&hub.challenge=c"), "vt"),
    ).toBeNull();
  });

  it("rejects a non-subscribe mode and a missing token config", () => {
    expect(
      whatsappVerifyChallenge(url("hub.mode=other&hub.verify_token=vt&hub.challenge=c"), "vt"),
    ).toBeNull();
    expect(
      whatsappVerifyChallenge(url("hub.mode=subscribe&hub.verify_token=&hub.challenge=c"), ""),
    ).toBeNull();
  });
});

describe("verifyWhatsappSignature", () => {
  const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const sig = (secret: string) =>
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts a valid X-Hub-Signature-256", () => {
    expect(
      verifyWhatsappSignature({ appSecret: "shh", rawBody, signature: sig("shh") }),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifyWhatsappSignature({ appSecret: "shh", rawBody, signature: sig("other") }),
    ).toBe(false);
  });

  it("rejects a missing header and a tampered body", () => {
    expect(verifyWhatsappSignature({ appSecret: "shh", rawBody, signature: null })).toBe(false);
    expect(
      verifyWhatsappSignature({ appSecret: "shh", rawBody: rawBody + "x", signature: sig("shh") }),
    ).toBe(false);
  });
});
