# @intentface/latch-drizzle

## 0.1.0

### Minor Changes

- 166c7a8: Store the prompt-cache and toolset columns the caching stats read.
  
  `latch_runs` gains `kind` and `tools_hash`; `latch_usage` gains `cache_read_tokens` and
  `cache_write_tokens`. All four are nullable and added by `migrate`, so an existing database
  needs no manual step and rows written before the upgrade simply read as absent.

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [b00e813]
- Updated dependencies [166c7a8]
  - @intentface/latch-agent-builder@0.1.0
  - @intentface/latch-memory@0.1.0
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
  - @intentface/latch-agent-builder@0.0.1
  - @intentface/latch-memory@0.0.1
