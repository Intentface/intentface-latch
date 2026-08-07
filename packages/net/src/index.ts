/**
 * @intentface/latch-net
 *
 * Network-safety primitives shared across the Latch stack. This root export
 * has zero third-party dependencies (Node built-ins only), so any host
 * package can depend on it without pulling heavier packages in; the
 * DNS-pinned egress fetch, which pulls in `undici`, lives behind the
 * `@intentface/latch-net/pinned` subpath.
 */
export {
  isPrivateV4,
  isBlockedHost,
  isBlockedResolved,
  assertPublicUrl,
} from "./ssrf.js";
export { isHostAllowed } from "./allowlist.js";
