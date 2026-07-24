/**
 * SSRF guards. The render service will fetch any URL an agent hands it, so a
 * page (or a prompt-injected link) could point it at internal/cloud-metadata
 * addresses. The canonical implementation lives in @intentface/latch-net
 * (shared by every Latch host that opens an outbound connection); this module
 * re-exports it so render.ts/server.ts imports keep working.
 */
export { isPrivateV4, isBlockedHost, isBlockedResolved } from "@intentface/latch-net";
