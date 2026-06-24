import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack request signature (the standard signing-secret scheme).
 *
 *   basestring = `v0:{timestamp}:{rawBody}`
 *   expected   = `v0=` + hex(HMAC_SHA256(signingSecret, basestring))
 *   compare    constant-time against the `x-slack-signature` header
 *
 * Also rejects stale timestamps (replay) outside `maxSkewSeconds` (default 5m,
 * Slack's recommendation). `rawBody` MUST be the exact bytes Slack sent — read
 * the request body as text once and pass it here (and reuse it for parsing).
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
  maxSkewSeconds?: number;
}): boolean {
  const { signingSecret, rawBody, signature, timestamp } = opts;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.maxSkewSeconds ?? 300;
  if (Math.abs(nowSec - ts) > skew) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
