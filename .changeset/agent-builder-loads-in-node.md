---
"@intentface/latch-agent-builder": patch
---

`@intentface/latch-agent-builder` is importable again in Node ESM.

0.9.1 shipped with relative imports missing their `.js` extension in five source
files. TypeScript accepts those under `moduleResolution: "Bundler"` and never
rewrites specifiers on emit, so the package compiled clean and then failed at
`import('@intentface/latch-agent-builder')` with `ERR_MODULE_NOT_FOUND` — and
since the exports map blocks deep paths, there was no consumer-side workaround.
Only the `/record` subpath, whose file already carried the extensions, loaded.

All 18 specifiers now carry `.js`. `pnpm verify:publish` also imports every
published JS export target in Node for real, so a target that exists but does
not load fails the release rather than the consumer.
