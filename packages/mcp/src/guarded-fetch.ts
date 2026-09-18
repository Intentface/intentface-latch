import { createPinnedFetch } from "@intentface/latch-net/pinned";
import type { FetchFunction } from "./oauth-fetch.js";

/**
 * The fetch every MCP request goes through — the transport's, and the OAuth
 * flow's.
 *
 * Two guarantees the plain `fetch` cannot give:
 *
 * **The address checked is the address connected to.** `host.open()` vets a
 * connection's hostname before opening it, but `fetch` then performs its own
 * DNS lookup: a name that answers public to the check and private to the
 * connect reaches an internal service carrying the caller's credentials. That
 * is a time-of-check/time-of-use gap, not a weak blocklist, and it closes only
 * by validating inside the lookup the socket itself uses —
 * `createPinnedFetch`. TLS is untouched: SNI and certificate validation stay
 * against the original hostname.
 *
 * **Addresses are checked on EVERY leg, not just the transport's.** An OAuth
 * flow follows addresses the MCP server chose: the authorization server named
 * in its protected-resource metadata, then that server's registration and
 * token endpoints. Those legs had no address check at all, which made adding a
 * custom MCP server by URL an SSRF with a read-back channel.
 *
 * Redirects are refused rather than followed — a 302 is another address the
 * server operator chose, and nothing in the MCP or OAuth protocols needs one.
 */
export interface GuardedFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Close the underlying agent. Keep-alive sockets would hold a test's event loop. */
  close(): Promise<void>;
}

export interface GuardedFetchOptions {
  /**
   * Permit private, loopback and link-local addresses — a trusted local or
   * in-cluster MCP server, or a developer's `http://localhost:3999/mcp`. This
   * is the connection's own `allowPrivateHost`, so the OAuth legs relax
   * exactly when the transport does and local development is unaffected.
   */
  allowPrivateHost?: boolean;
  /** Test seam: the resolver `createPinnedFetch` vets. Defaults to `node:dns`. */
  lookup?: Parameters<typeof createPinnedFetch>[0] extends { lookup?: infer L } ? L : never;
}

/**
 * Normalize to what the pinned fetch accepts. undici rejects a `Request` built
 * by another fetch implementation (a cross-realm brand check), so a `Request`
 * is unpacked rather than passed through. The OAuth SDK calls fetch as
 * `(url, init)`; this exists so a caller that doesn't cannot silently bypass
 * the guard.
 */
async function unpack(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<[string | URL, RequestInit]> {
  if (typeof input === "string" || input instanceof URL) return [input, init ?? {}];
  const request = input as Request;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return [
    request.url,
    {
      method: request.method,
      headers,
      ...(body && body.byteLength > 0 ? { body } : {}),
      // The Request's own signal, or nothing survives cancellation: an aborted
      // MCP call would keep its socket until the server answered. `init` still
      // wins, so a caller passing both replaces it deliberately.
      signal: request.signal,
      ...init,
    },
  ];
}

export function createGuardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
  const pinned = createPinnedFetch({
    allowPrivate: options.allowPrivateHost === true,
    ...(options.lookup ? { lookup: options.lookup as never } : {}),
  });
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const [url, base] = await unpack(input, init);
    // `redirect: "error"` last: a caller asking to follow redirects is asking
    // to connect to an address nothing vetted.
    return pinned(url, { ...base, redirect: "error" });
  }) as GuardedFetch;
  guarded.close = () => pinned.close();
  return guarded;
}

/**
 * The guarded fetch, with a host's own fetch layered on top when it supplied
 * one (discovery-document normalization, typically). The host's wrapper sees
 * the requests; the guarded fetch still opens the sockets.
 */
export function composeGuardedFetch(
  guarded: GuardedFetch,
  wrap?: (base: FetchFunction) => FetchFunction,
): GuardedFetch {
  if (!wrap) return guarded;
  const composed = wrap(guarded as FetchFunction) as GuardedFetch;
  composed.close = () => guarded.close();
  return composed;
}
