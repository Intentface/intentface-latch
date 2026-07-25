import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guards. The render service will fetch any URL an agent hands it, so a
 * page (or a prompt-injected link) could point it at internal/cloud-metadata
 * addresses. Two layers: a string-level blocklist for encoded/literal private
 * hosts, and a DNS-resolution backstop for public names that resolve private.
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
 * Parse an IPv6 literal into its 16 bytes — compressed (`::1`), fully expanded
 * (`0:0:0:0:0:0:0:1`), or with an embedded IPv4 tail (`::ffff:127.0.0.1`).
 * Null for anything that isn't a valid IPv6 literal. (Kept in sync with
 * `@intentface/latch-net` — the renderer can't resolve that workspace dep in
 * its standalone Docker build, so the guard is duplicated here.)
 */
export function parseIPv6(input: string): number[] | null {
  let h = input.toLowerCase().split("%")[0]; // drop any zone id
  const dotted = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[1].split(".").map(Number);
    if (o.some((x) => x > 255)) return null;
    const hextets = `${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
    h = h.slice(0, h.length - dotted[1].length) + hextets;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const toBytes = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      const n = Number.parseInt(g, 16);
      out.push((n >> 8) & 255, n & 255);
    }
    return out;
  };
  const head = toBytes(halves[0]);
  const rest = toBytes(halves[1] ?? "");
  if (!head || !rest) return null;
  const known = head.length + rest.length;
  if (halves.length === 2) {
    const gap = 16 - known;
    return gap < 0 ? null : [...head, ...Array(gap).fill(0), ...rest];
  }
  return known === 16 ? [...head, ...rest] : null;
}

/** True if a 16-byte IPv6 address is unspecified/loopback/ULA/link-local, or an IPv4-mapped/compatible private address. */
export function isPrivateV6(b: number[]): boolean {
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const compat = b.slice(0, 12).every((x) => x === 0);
  if (mapped || compat) return isPrivateV4(b.slice(12).join("."));
  if ((b[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  return false;
}

/**
 * String-level blocklist. Mirrors `@intentface/latch-net`: trailing-dot, any
 * IPv6 literal spelling (loopback/ULA/link-local + IPv4-mapped/compatible),
 * bare integer / hex encodings of IPv4 (2130706433, 0x7f000001), short dotted
 * forms (127.1). Best-effort and conservative — strictly more blocking.
 * `isBlockedResolved` backs this up to defeat DNS rebinding.
 */
export function isBlockedHost(host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // unwrap IPv6 literal
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h === "::") return true;
  if (h.includes(":")) {
    // Parse the full IPv6 literal (any spelling) and classify its bytes.
    const bytes = parseIPv6(h);
    return bytes ? isPrivateV6(bytes) : false;
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
    return addrs.some(({ address, family }) => {
      if (family === 4) return isPrivateV4(address);
      const bytes = parseIPv6(address); // same classifier as the literal path
      return bytes ? isPrivateV6(bytes) : false;
    });
  } catch {
    return true; // fail closed — a lookup error must not open the gate (a
    // rebinding/flaky resolver could otherwise slip a private target through)
  }
}
