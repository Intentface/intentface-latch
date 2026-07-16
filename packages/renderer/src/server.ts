import http, { type IncomingMessage } from "node:http";
import { isBlockedHost, isBlockedResolved } from "./ssrf.js";
import {
  render,
  closeBrowser,
  INCLUDE_PARTS,
  DEFAULT_INCLUDE,
  MAX_STEPS,
  type IncludePart,
  type Step,
} from "./render.js";

/**
 * latch-renderer — HTTP entry point. Stateless render-once service (fits
 * Vercel's autoscaled container functions): GET /render?url=<https url> loads
 * the page in headless Chromium and returns the extracted content. Auth is
 * optional (edge-gated behind Vercel Deployment Protection when the token is
 * unset). See ./render.ts for the render core, ./ssrf.ts for host guards.
 *
 * The ONLY consumer is the platform's `render_fetch` app tool
 * (apps/latch-platform/src/lib/render-fetch.ts) — a plain HTTP client, no
 * OpenAPI/connection machinery, so this server serves no spec.
 */

const PORT = Number(process.env.PORT ?? 80);
const TOKEN = process.env.RENDER_FETCH_TOKEN;

/**
 * Own auth is OPTIONAL: with RENDER_FETCH_TOKEN unset, all requests pass —
 * safe only when an edge gate (mandatory Vercel Deployment Protection) already
 * rejects unauthenticated traffic before it reaches this server. Set the env
 * to re-enable app-level auth (accepted via `Authorization: Bearer`, the
 * `x-vercel-protection-bypass` header, or `?token=` for curl).
 */
function isAuthorized(req: IncomingMessage, requestUrl: URL): boolean {
  if (!TOKEN) return true; // edge-gated deployment; see note above
  if (req.headers.authorization === `Bearer ${TOKEN}`) return true;
  if (req.headers["x-vercel-protection-bypass"] === TOKEN) return true;
  return (
    requestUrl.searchParams.get("token") === TOKEN ||
    requestUrl.searchParams.get("x-vercel-protection-bypass") === TOKEN
  );
}

const isIncludePart = (p: string): p is IncludePart => (INCLUDE_PARTS as readonly string[]).includes(p);

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://internal");
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  if (requestUrl.pathname === "/healthz") return respond(200, { ok: true });
  if (requestUrl.pathname !== "/render") return respond(404, { ok: false, error: "Not found. Use /render?url=..." });
  if (!isAuthorized(req, requestUrl)) {
    return respond(401, { ok: false, error: "Missing or invalid token." });
  }

  // Distinguish "missing" from "malformed" — a client that drops the url param
  // (e.g. a tool wrapper that failed to map its arguments into the query
  // string) used to get "Invalid url parameter", and would then waste retries
  // reformatting a URL that was never the problem.
  const urlParam = requestUrl.searchParams.get("url");
  if (!urlParam) {
    const received = [...requestUrl.searchParams.keys()].filter((k) => k !== "token");
    return respond(400, {
      ok: false,
      error:
        `Missing url query parameter. Expected GET /render?url=https://... ` +
        `(received query keys: ${received.length ? received.join(", ") : "none"}).`,
    });
  }
  let target: URL;
  try {
    target = new URL(urlParam);
  } catch {
    return respond(400, { ok: false, error: `Malformed url parameter: ${JSON.stringify(urlParam)}` });
  }
  if (target.protocol !== "https:") return respond(400, { ok: false, error: "Only https URLs are allowed." });
  if (isBlockedHost(target.hostname)) return respond(400, { ok: false, error: "Host is not allowed." });
  if (await isBlockedResolved(target.hostname)) {
    return respond(400, { ok: false, error: "Host resolves to a private address." });
  }

  const includeRaw = requestUrl.searchParams.get("include");
  const includeParts = includeRaw
    ? includeRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_INCLUDE];
  const unknown = includeParts.filter((p) => !isIncludePart(p));
  if (unknown.length) {
    return respond(400, { ok: false, error: `Unknown include part(s): ${unknown.join(", ")}. Valid: ${INCLUDE_PARTS.join(", ")}.` });
  }

  // `steps` is a JSON-encoded array of actions ({click|waitFor|scroll|waitMs}),
  // run in order in the single render pass. Malformed JSON is a 400, not a crash.
  let steps: Step[] | undefined;
  const stepsRaw = requestUrl.searchParams.get("steps");
  if (stepsRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stepsRaw);
    } catch {
      return respond(400, { ok: false, error: "steps must be a JSON array of action objects." });
    }
    if (!Array.isArray(parsed)) return respond(400, { ok: false, error: "steps must be a JSON array." });
    if (parsed.length > MAX_STEPS) return respond(400, { ok: false, error: `steps: at most ${MAX_STEPS} actions per request.` });
    steps = parsed as Step[];
  }
  const scroll = requestUrl.searchParams.get("scroll") === "true";

  try {
    respond(
      200,
      await render(target.href, {
        include: new Set(includeParts.filter(isIncludePart)),
        waitFor: requestUrl.searchParams.get("waitFor") ?? undefined,
        clickSelector: requestUrl.searchParams.get("clickSelector") ?? undefined,
        steps,
        scroll,
      }),
    );
  } catch (e) {
    respond(502, { ok: false, error: e instanceof Error ? e.message : "Render failed" });
  }
});

server.listen(PORT, () => console.log(`latch-renderer listening on :${PORT}`));

// Vercel scale-in sends SIGTERM with a 30 s grace period.
process.on("SIGTERM", async () => {
  server.close();
  await closeBrowser();
  process.exit(0);
});
