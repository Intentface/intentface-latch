/**
 * @intentface/latch-net
 *
 * Network-safety primitives shared across the Latch stack. This root export
 * is Node built-ins only (safe to reach client bundles); the DNS-pinned
 * egress fetch, which pulls in `undici`, lives behind the server-only
 * `@intentface/latch-net/pinned` subpath.
 */
export {
  isPrivateV4,
  isBlockedHost,
  isBlockedResolved,
  assertPublicUrl,
} from "./ssrf.js";
export { isHostAllowed } from "./allowlist.js";
