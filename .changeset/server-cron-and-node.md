---
"@intentface/latch-server": minor
---

- **Vercel Cron can call `cron/run` directly.** The route now accepts `GET` as well as `POST`, and the secret as `Authorization: Bearer <secret>` as well as `x-latch-cron-secret`, compared in constant time. Set `cronSecret: process.env.CRON_SECRET` and point `vercel.json` at the route; `createLatchApp` reads `CRON_SECRET` when `LATCH_CRON_SECRET` isn't set.
- **`@intentface/latch-server/node`:** `toNodeHandler(handler)` mounts the handler in Express, Fastify, NestJS or `http.createServer`, streaming both ways. It keeps several `Set-Cookie` headers apart, reads the first `x-forwarded-proto`, uses `req.body` when a body parser already read the request, and closes the stream cleanly when the client leaves instead of crashing the process. It replaces the bridge the docs had you copy.
