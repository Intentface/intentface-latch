---
"@intentface/latch-server": patch
---

`createLatchApp({ context })` accepts the plain-function form, `async ({ principal }) => ({ … })`, as `createRuntime` does since 0.17.0. The deprecated `{ build }` object still works.
