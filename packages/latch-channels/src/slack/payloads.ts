/**
 * Signed interaction payloads — what rides in a Block Kit button `value`.
 *
 * v1 buttons carried unsigned JSON: trust rested entirely on Slack's request
 * signature over the outer POST, and a payload never expired. v2 payloads are
 * HMAC-signed with a key DERIVED from the app's signing secret (domain-
 * separated, so a signature over a button value can never double as anything
 * else), carry the actor who may click, and expire.
 *
 * Format: `b64url(json) + "." + b64url(HMAC_SHA256(derivedKey, json))`.
 * Slack caps a button `value` at 2000 chars — encode asserts it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ActionPayload {
  v: 2;
  kind: "approval";
  /** The Latch chat the approval belongs to. */
  chatId: string;
  /** The approval to resolve via `runtime.applyApproval`. */
  approvalId: string;
  /** Display only — never trusted for dispatch. */
  tool?: string;
  /** Slack user id whose message triggered the run — the only one who may click. */
  actor: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

const DOMAIN = "latch-slack-action-v2";
const DEFAULT_TTL_S = 7 * 24 * 3600;

/** Key derivation: per-app isolation for free, zero new secrets to manage. */
function deriveKey(signingSecret: string): Buffer {
  return createHmac("sha256", signingSecret).update(DOMAIN).digest();
}

function sign(json: Buffer, signingSecret: string): Buffer {
  return createHmac("sha256", deriveKey(signingSecret)).update(json).digest();
}

export function encodeAction(
  payload: Omit<ActionPayload, "v" | "exp"> & { exp?: number },
  signingSecret: string,
  nowMs = Date.now(),
): string {
  const full: ActionPayload = {
    exp: Math.floor(nowMs / 1000) + DEFAULT_TTL_S,
    ...payload,
    v: 2,
  };
  const json = Buffer.from(JSON.stringify(full), "utf8");
  const value = `${json.toString("base64url")}.${sign(json, signingSecret).toString("base64url")}`;
  if (value.length > 2000) {
    // A payload is ids + one user id — hitting this means a bug upstream
    // (e.g. someone stuffed tool input in), not an oversized legitimate value.
    throw new Error(`slack action payload too large (${value.length} > 2000)`);
  }
  return value;
}

/**
 * Decode + verify. Null for anything not exactly right: bad shape, wrong
 * signature, expired, foreign version. Callers treat null as "this button is
 * dead", never as an error to surface loudly (stale buttons are normal).
 */
export function decodeAction(
  value: string,
  signingSecret: string,
  nowMs = Date.now(),
): ActionPayload | null {
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  let json: Buffer;
  let sig: Buffer;
  try {
    json = Buffer.from(value.slice(0, dot), "base64url");
    sig = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const expected = sign(json, signingSecret);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    return null;
  }
  const p = parsed as Partial<ActionPayload> | null;
  if (
    !p ||
    p.v !== 2 ||
    p.kind !== "approval" ||
    typeof p.chatId !== "string" ||
    typeof p.approvalId !== "string" ||
    typeof p.actor !== "string" ||
    typeof p.exp !== "number"
  ) {
    return null;
  }
  if (p.exp * 1000 < nowMs) return null;
  return p as ActionPayload;
}
