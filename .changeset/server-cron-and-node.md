---
"@intentface/latch-server": minor
---

- **Vercel Cron can call `cron/run` directly.** The route now accepts `GET` as well as `POST`, and the secret as `Authorization: Bearer <secret>` as well as `x-latch-cron-secret`, compared in constant time (the scheme name case-insensitively). Set `cronSecret: process.env.CRON_SECRET` and point `vercel.json` at the route; `createLatchApp` reads `CRON_SECRET` when `LATCH_CRON_SECRET` isn't set.
- **`@intentface/latch-server/node`:** `toNodeHandler(handler)` mounts the handler in Express, Fastify, NestJS or `http.createServer`, streaming both ways. It keeps several `Set-Cookie` headers apart, takes the protocol from the first `x-forwarded-proto` or else the TLS socket, and closes the stream cleanly when the client leaves instead of crashing the process; if the answer's own stream fails, it rejects. When a body parser already read the request, it sends what the parser left (`req.body`, or Fastify's `request.body` passed as the third argument), encoded again as JSON or a form to match the request. It replaces the bridge the docs had you copy.
