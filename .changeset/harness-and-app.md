---
"@intentface/latch-core": minor
"@intentface/latch-server": minor
---

The last two pieces every host used to hand-write.

- `@intentface/latch-core/harness`: the default harness tools — sandbox
  `bash`/`read_file`/`write_file`/`glob`/`grep` over the `sandbox` seam,
  `web_fetch` (clean markdown/text, images and PDFs as viewable media,
  SSRF-gated and DNS-pinned), `askUser` (client-handled pause), and
  `list_schedules`/`cancel_schedule` over `options.context.runtime`. Pass
  `harnessTools: defaultHarnessTools()`. `web_fetch`'s `turndown` and
  `@intentface/latch-net` are OPTIONAL peers of core, imported on first call.
  Lifted from latch-platform's sandbox/tools.ts + web-fetch.ts; the platform
  keeps only its policy (render_fetch, delivery-aware create_schedule, Slack
  tools).
- `createLatchApp({ storage, agents, resolveContext })` in latch-server (and
  `createLatchHonoApp` on the hono subpath): the composition root with the
  defaults wired — durability on, croner cron evaluator, the models.dev
  catalog with pricing / reasoning / web-tool / prompt-caching hooks, the
  harness tools, the handler mounted, and an in-process `runtime.cron()`
  driver on long-running hosts (off on serverless). `agents` may be a
  function of the loaded catalog. Every default is overridable via
  `runtime` / `handler`. The example server is now ~30 lines of wiring.
