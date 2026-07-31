import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

import { isBlockedHost, isPrivateV4, isPrivateV6, parseIPv6 } from "./ssrf.js";

/**
 * DNS-pinned SSRF-safe fetch.
 *
 * The guards in `ssrf.ts` validate a hostname and then hand it to `fetch`,
 * which performs its OWN second DNS lookup — a name that resolves public
 * during the check and private when the connection opens (DNS rebinding /
 * TOCTOU) defeats them. This module closes that gap by vetting addresses
 * INSIDE the lookup the connection itself uses (undici `Agent` →
 * `buildConnector` → `net`/`tls.connect` `lookup`), so there is no
 * validate-vs-connect distance at all. TLS is untouched: undici sets
 * `servername` from the URL host before the lookup runs, so SNI and
 * certificate validation stay against the original hostname and
 * `rejectUnauthorized` keeps its default.
 *
 * Lives behind the `@intentface/latch-net/pinned` subpath (not the root
 * export) because it pulls in `undici` — the root entry stays third-party-free.
 *
 * Redirect hops dispatch through the same agent, so with `redirect: "follow"`
 * every hop is connect-vetted too (call sites here still use "error"/"manual"
 * for better messages and header hygiene).
 */

/**
 * Input is `string | URL` only — undici's `fetch` rejects `Request` objects
 * built by another fetch implementation (cross-realm brand check), so the
 * type must not admit them.
 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface PinnedFetch extends FetchLike {
  /** Close the underlying Agent (keep-alive sockets would hold a test's event loop). */
  close(): Promise<void>;
}

type Addr = { address: string; family: number };

/**
 * Callback-style resolver, injectable for tests. Always invoked with
 * `all: true`; other options (`family`, `hints`) pass through from `net`.
 */
export type BaseLookup = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (err: NodeJS.ErrnoException | null, addresses?: Addr[]) => void,
) => void;

export interface PinnedFetchOptions {
  /**
   * Skip the private-address vetting (trusted local backend, tests against
   * 127.0.0.1 servers). The pinning path itself is unchanged.
   */
  allowPrivate?: boolean;
  /** Test seam; defaults to `node:dns` `lookup`. */
  lookup?: BaseLookup;
  /**
   * Extra socket/TLS options for the connector (tests: a fixture `ca`).
   * `autoSelectFamily` is widened in explicitly: it IS typed in the union's
   * `TcpNetConnectOpts` member, but that member requires `port`, so a partial
   * options object can never select it.
   */
  connect?: buildConnector.BuildOptions & { autoSelectFamily?: boolean };
}

function isPrivateAddress({ address, family }: Addr): boolean {
  if (family === 4) return isPrivateV4(address);
  const bytes = parseIPv6(address);
  return bytes ? isPrivateV6(bytes) : true; // unparseable resolver output → fail closed
}

/**
 * Wrap a resolver so every address it returns is classified before the socket
 * ever sees it: error (fail closed) on lookup failure, an empty answer, or —
 * unless `allowPrivate` — any private/internal address. Node calls the lookup
 * in two shapes depending on `options.all` (`autoSelectFamily` uses the array
 * form); both are honored.
 */
function vettingLookup(base: BaseLookup, allowPrivate: boolean) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number },
    callback: (err: Error | null, address?: unknown, family?: number) => void,
  ): void => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const addrs = addresses ?? [];
      if (addrs.length === 0) {
        return callback(new Error(`lookup returned no addresses: ${hostname}`));
      }
      if (!allowPrivate) {
        const bad = addrs.find(isPrivateAddress);
        if (bad) {
          return callback(
            new Error(
              `Blocked private/internal address: ${hostname} -> ${bad.address}`,
            ),
          );
        }
      }
      if (options.all) return callback(null, addrs);
      // Scalar shape: honor a requested family even if the base resolver
      // ignored the forwarded option (real dns.lookup honors it; the contract
      // on BaseLookup doesn't require it). No cross-family fallback — handing
      // back the wrong family is worse than failing, and real dns.lookup
      // reports ENOTFOUND for a family with no answers.
      const pick = options.family
        ? addrs.find((a) => a.family === options.family)
        : addrs[0];
      if (!pick) {
        return callback(
          new Error(
            `lookup returned no addresses for family ${options.family}: ${hostname}`,
          ),
        );
      }
      callback(null, pick.address, pick.family);
    });
  };
}

/**
 * Build a fetch whose connections resolve through the vetting lookup above.
 * One shared `Agent` per instance — pooled keep-alive sockets are safe to
 * reuse because they were vetted when they connected.
 */
export function createPinnedFetch(options: PinnedFetchOptions = {}): PinnedFetch {
  const { allowPrivate = false, lookup = dnsLookup as unknown as BaseLookup } =
    options;
  const base = buildConnector({
    ...options.connect,
    // Passed through to net/tls.connect; spread AFTER options.connect so a
    // caller can never displace the vetting resolver. (Cast for the same
    // BuildOptions-union reason as `autoSelectFamily` above.)
    lookup: vettingLookup(lookup, allowPrivate),
  } as buildConnector.BuildOptions);
  // net.connect skips `lookup` entirely for IP-literal hosts — vet those here.
  const connector: buildConnector.connector = (opts, cb) => {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && isIP(host) !== 0 && isBlockedHost(host)) {
      cb(new Error(`Blocked private/internal address: ${host}`), null);
      return;
    }
    base(opts, cb);
  };
  const agent = new Agent({ connect: connector });
  // undici's fetch, not the global: mixing this Agent into Node's bundled
  // fetch is cross-version undici and unsupported. Types differ from lib.dom
  // but the runtime objects are the same implementation Node bundles.
  const fn: FetchLike = (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Omit<Parameters<typeof undiciFetch>[1] & object, "dispatcher">),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  return Object.assign(fn, { close: () => agent.close() });
}

/**
 * Shared default instance, constructed lazily (no Agent at import time).
 * Deliberately exposed WITHOUT `close()` — it is shared, so no caller may
 * tear it down under the others; a long-lived server never closes it, and
 * idle keep-alive sockets expire on undici's own timeout.
 */
let shared: PinnedFetch | undefined;
export const pinnedFetch: FetchLike = (input, init) =>
  (shared ??= createPinnedFetch())(input, init);
