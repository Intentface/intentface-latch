/**
 * @intentface/latch-net
 *
 * Network-safety primitives shared across the Latch stack. Zero runtime
 * dependencies (Node built-ins only), so any host package can depend on it
 * without pulling heavier packages in.
 */
export {
  isPrivateV4,
  isBlockedHost,
  isBlockedResolved,
  assertPublicUrl,
} from "./ssrf.js";
