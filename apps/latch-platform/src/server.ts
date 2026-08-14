import defaultEntry, {
  createServerEntry,
} from "@tanstack/react-start/server-entry"

// Vercel Skew Protection for TanStack Start (not on Vercel's auto-supported
// framework list, so the integration is manual): stamp document responses
// with a `__vdpl` cookie holding this deployment's id. Vercel's edge routes
// any request carrying the cookie to that exact deployment, so a tab left
// open across a redeploy keeps resolving its lazy chunks from the build that
// rendered it instead of 404ing. `Path=/assets` is load-bearing: it keeps the
// cookie off document navigations, which must always reach the latest
// deployment — a cookie pinning documents would trap the browser on the old
// build until the cookie expired. Requires the Skew Protection toggle in
// Vercel project settings (sets VERCEL_SKEW_PROTECTION_ENABLED=1); without it
// this is a no-op. Max-Age tracks Vercel's default skew max-age (1 day) —
// pinning to a deployment past that window 404s harder than not pinning.
const SKEW_COOKIE_MAX_AGE_SECONDS = 86_400

function skewProtectionCookie(request: Request): string | null {
  if (process.env.VERCEL_SKEW_PROTECTION_ENABLED !== "1") return null
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID
  if (!deploymentId) return null
  const isDocument =
    request.headers.get("sec-fetch-dest") === "document" ||
    (!request.headers.has("sec-fetch-dest") &&
      (request.headers.get("accept") ?? "").includes("text/html"))
  if (!isDocument) return null
  return `__vdpl=${deploymentId}; Path=/assets; Max-Age=${SKEW_COOKIE_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Strict`
}

export default createServerEntry({
  async fetch(...args) {
    const response = await defaultEntry.fetch(...args)
    const cookie = skewProtectionCookie(args[0])
    if (!cookie) return response
    const stamped = new Response(response.body, response)
    stamped.headers.append("set-cookie", cookie)
    return stamped
  },
})
