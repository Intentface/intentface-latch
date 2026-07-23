import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guards for any Latch host that opens an outbound connection to a
 * config- or agent-supplied URL (MCP servers, OpenAPI backends, the renderer's
 * fetch service). A URL could point at internal/cloud-metadata addresses, so
 * there are two layers: a string-level blocklist for encoded/literal private
 * hosts, and a DNS-resolution backstop for public names that resolve private.
 *
 * These are best-effort and deliberately conservative (they err toward
 * blocking). They complement, but do not replace, a positive allowlist — see
 * `@intentface/latch-mcp`'s per-tenant `allowedHosts`.
 */

/** True if a dotted-decimal IPv4 (or a short form like 127.1) is private/loopback/link-local. */
export function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length < 2 || parts.length > 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false;
  const a = Number(parts[0]);
  const b = parts.length >= 2 ? Number(parts[1]) : 0;
  if (a === 127 || a === 10 || a === 0) return true; // loopback, private, "this host"
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (carrier / internal)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224) return true; // multicast 224/4 + reserved/broadcast 240/4 (incl. 255.255.255.255)
  return false;
}

/**
 * String-level blocklist: trailing-dot, bracketed IPv6 (loopback/ULA/link-local
 * + IPv4-mapped), bare integer / hex encodings of IPv4 (2130706433,
 * 0x7f000001), short dotted forms (127.1). Best-effort and conservative —
 * strictly more blocking. `isBlockedResolved` backs this up to defeat DNS
 * rebinding.
 */
export function isBlockedHost(host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // unwrap IPv6 literal
  if (h === "localhost" || h.endsWith(".local") || h === "::1" || h === "::") return true;
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || /^fe[89ab]/.test(h)) return true;
    if (h.startsWith("::ffff:")) return true; // IPv4-mapped
    const mapped = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped?.[1]) h = mapped[1];
    else return false;
  }
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true; // bare int / hex = encoded IPv4
  return isPrivateV4(h);
}

/**
 * DNS-rebinding backstop: resolve the hostname and reject if ANY resolved
 * address is private/loopback/link-local. The string check above cannot catch
 * `http://public-name/` that resolves to 169.254.169.254 — this does.
 */
export async function isBlockedResolved(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return false; // literal IPs already handled by isBlockedHost
  try {
    const addrs = await lookup(hostname, { all: true });
    return addrs.some(({ address, family }) =>
      family === 4
        ? isPrivateV4(address)
        : /^(::1|::|fc|fd|fe[89ab])/.test(address.toLowerCase()) || address.toLowerCase().startsWith("::ffff:"),
    );
  } catch {
    return false; // let the fetch itself fail on an unresolvable host
  }
}

/**
 * Convenience for callers that want one hard gate: parse `input`, then reject a
 * private/internal literal (`isBlockedHost`) or a name that resolves private
 * (`isBlockedResolved`). Returns the parsed `URL` on success; throws otherwise.
 */
export async function assertPublicUrl(input: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new Error(`Invalid URL: ${String(input)}`);
  }
  const host = url.hostname;
  if (isBlockedHost(host) || (await isBlockedResolved(host))) {
    throw new Error(`Blocked private/internal address: ${host}`);
  }
  return url;
}
