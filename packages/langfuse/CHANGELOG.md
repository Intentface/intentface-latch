# @intentface/latch-langfuse

## 0.15.0

### Patch Changes

- Updated dependencies [d4356e3]
- Updated dependencies [d77af82]
  - @intentface/latch-core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [ab7a88e]
  - @intentface/latch-core@0.14.0

## 0.13.3

### Patch Changes

- Updated dependencies [4fe9ecd]
  - @intentface/latch-core@0.13.3

## 0.13.2

### Patch Changes

- Updated dependencies [dfe9b90]
  - @intentface/latch-core@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [6fed7fa]
- Updated dependencies [cf10a1c]
  - @intentface/latch-core@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [3b0dbfb]
- Updated dependencies [71630e1]
- Updated dependencies [80f1630]
- Updated dependencies [015e0a1]
- Updated dependencies [96013b6]
  - @intentface/latch-core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [e602c55]
  - @intentface/latch-core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [ae91f9c]
  - @intentface/latch-core@0.11.0

## 0.10.0

### Minor Changes

- c70daf1: Agent records are now versioned, so editing a prompt no longer destroys the one
  that was running.
  
  `upsert` publishes: it writes the live record and appends a version, unless the
  content is unchanged — history stays a list of real changes rather than of save
  events. Rolling back is `activateVersion`, which moves a pointer and appends
  nothing, so flipping between two configurations can't inflate history. Each
  version carries its author, the fields that differ from its predecessor, and an
  optional note. A separate activation log records who made which version live and
  when, which the version list alone can't say once rollback stopped appending.
  
  Drafts are stored per editor, not per agent: `owner` is an isolation boundary a
  whole org shares, so a single draft per agent would let two admins silently
  overwrite each other's half-written prompt. A draft never affects a running
  agent, and carries the version it started from so a stale publish is detectable.
  
  The whole record is snapshotted, not just the instructions. A version is
  therefore always a configuration that actually ran together — restoring a prompt
  alone could produce a combination that never existed, such as one referencing a
  tool removed two edits ago.
  
  Runs and traces now record which version produced them (`agent_version` on the
  run, an `agent-version:<n>` Langfuse tag), so a past answer stays attributable to
  an exact configuration and scores can be compared across versions.
  
  Migrating backfills every existing agent as v1. Without it the first publish
  after upgrading would create v1 from the NEW content and the prompt that had been
  running would be lost — the exact failure this feature exists to prevent.

### Patch Changes

- Updated dependencies [65d1de5]
- Updated dependencies [c70daf1]
  - @intentface/latch-core@0.10.0

## 0.9.1

### Patch Changes

- 8311508: Publish to the public npm registry.
  
  Installing no longer needs an `.npmrc`, a registry mapping or a token:
  `pnpm add @intentface/latch-core` just works. Every tarball now ships the MIT
  license text, and each manifest carries `keywords`, `homepage` and `bugs`.
  
  No code or API changes. The versions previously published to GitHub Packages
  stay where they are; new releases go to npm only.
- Updated dependencies [4b5e9eb]
- Updated dependencies [8311508]
- Updated dependencies [516d8f0]
- Updated dependencies [8fd120a]
  - @intentface/latch-core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [ebc0afd]
- Updated dependencies [d062dd2]
- Updated dependencies [8745142]
- Updated dependencies [cbbd775]
- Updated dependencies [78a40e3]
- Updated dependencies [7d3c553]
- Updated dependencies [b22b3cf]
  - @intentface/latch-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [e0e2000]
  - @intentface/latch-core@0.8.1

## 0.8.0

### Patch Changes

- Updated dependencies [c5a64fd]
  - @intentface/latch-core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fcef9d2]
- Updated dependencies [fcef9d2]
  - @intentface/latch-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [3721c48]
- Updated dependencies [8b9e1c8]
  - @intentface/latch-core@0.6.0

## 0.5.0

### Patch Changes

- @intentface/latch-core@0.5.0

## 0.4.1

### Patch Changes

- @intentface/latch-core@0.4.1

## 0.4.0

### Patch Changes

- @intentface/latch-core@0.4.0

## 0.3.1

### Patch Changes

- @intentface/latch-core@0.3.1

## 0.3.0

### Patch Changes

- Updated dependencies [ddfa57b]
  - @intentface/latch-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [194c789]
- Updated dependencies [c782ec9]
  - @intentface/latch-core@0.2.0

## 0.1.0

### Patch Changes

- b00e813: Publish internal `@intentface/latch-*` dependencies as caret ranges instead of exact pins.
  
  These packages previously declared each other at an exact version, so installing two of
  them at different patch levels put a second copy of the shared package in `node_modules` —
  its own module registry, its own `instanceof` identities, and no error to say so. They now
  declare `^<version>`, which dedupes against the range in your own `package.json`.
  
  Nothing to do on your side beyond installing; a fresh install collapses any duplicate that
  an earlier version produced.
- Updated dependencies [166c7a8]
  - @intentface/latch-core@0.1.0

## 0.0.1

### Patch Changes

- Updated dependencies [9dd4f7a]
  - @intentface/latch-core@0.0.1
