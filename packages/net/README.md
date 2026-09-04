# @intentface/latch-net

Network-safety primitives for Latch — SSRF guards and a DNS-pinned egress `fetch`, shared by every host that opens an outbound connection on a model's behalf.

The root export has **zero third-party dependencies** (Node built-ins only), so any package can depend on it without pulling weight in. The pinned fetch, which needs `undici`, sits behind the `/pinned` subpath.

## What it does

- **`assertPublicUrl`** — the front-line check. Parses the URL and rejects any host that is, or resolves to, a private, loopback, link-local or otherwise internal address. Returns the parsed `URL` so the caller can keep using it.
- **`isBlockedHost` / `isBlockedResolved` / `isPrivateV4`** — the predicates behind it. The string-level one is deliberately conservative, covering `.localhost` and `.local` names, IPv6 literals in any spelling, and the integer and hex encodings of an IPv4 address. The resolving one is the rebinding backstop.
- **`isHostAllowed`** — positive allowlist matching (an exact host, or `.suffix` for subdomains), used to bound which hosts a tenant may reach at all. It complements the blocklist rather than replacing it.
- **`createPinnedFetch` / `pinnedFetch`** (`@intentface/latch-net/pinned`) — a `fetch` that vets addresses **inside** the lookup the connection itself uses.

## Why the pinned fetch exists

Checking a hostname and then handing it to `fetch` leaves a gap: `fetch` performs its own second DNS lookup, so a name that resolves public during the check and private when the socket opens defeats the guard. That is DNS rebinding, and it is a time-of-check/time-of-use bug, not a weak blocklist.

`createPinnedFetch` closes the gap by validating in the undici connector's `lookup`, so there is no distance between validating and connecting. TLS is untouched: SNI and certificate validation stay against the original hostname, and redirect hops dispatch through the same agent, so every hop is connect-vetted too.

```ts
import { assertPublicUrl } from "@intentface/latch-net";
import { createPinnedFetch } from "@intentface/latch-net/pinned";

await assertPublicUrl(url); // throws on private / non-public targets
const fetch = createPinnedFetch();
const response = await fetch(url, { redirect: "follow" });
```

## Where it fits

An optional peer of `@intentface/latch-core`, required by its `web_fetch` harness tool. `latch-mcp` uses the allowlist to bound MCP server hosts, and any host tool that fetches a user-supplied URL should route through it.
