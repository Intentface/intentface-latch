# Releasing

The `@intentface/latch-*` packages publish to the **public npm registry**.
Everything is driven by
[changesets](https://github.com/changesets/changesets); no one runs
`npm publish` by hand.

Publishing needs one secret: `NPM_TOKEN`, a **granular** access token for the
`@intentface` organization with read/write on the scope and **2FA bypass**
enabled (without that, the job hangs on a one-time-password prompt instead of
failing). Classic tokens, including the automation tokens this kind of workflow
used for years, were
[revoked in December 2025](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)
and cannot be recreated.

**The token is a bootstrap, not the destination.** A granular write token now
[expires after 90 days at most](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/),
so a token-based release breaks quarterly until someone rotates it. See
[Trusted publishing](#trusted-publishing-the-way-off-the-token-treadmill).

## The flow

1. **In your PR**, describe the change:

   ```bash
   pnpm changeset
   ```

   Pick a bump (`patch` / `minor` / `major`) and write one line about what
   changed for a consumer. This creates a markdown file in `.changeset/` —
   commit it with your code. A PR with no consumer-visible change needs no
   changeset.

2. **Merge to `main`.** The Release workflow runs `typecheck`, `test` and
   `build`, then opens (or updates) a **"chore(release): version packages"** PR
   that applies every pending changeset — bumping versions and writing
   changelogs.

3. **Merge the version PR.** The workflow runs again, sees no pending
   changesets, and publishes to npm.

So a release is always two merges: your change, then the version PR. Nothing
publishes straight off a feature merge.

`pnpm release` runs `typecheck:packages`, `test`, `build` and `verify:publish`
before `changeset publish`, so publishing unverified packages isn't possible even
by invoking it directly. The workflow also runs those four as separate steps —
for legible CI output, and so a failure lands before the changesets action starts.
Turbo caches, so the duplication is nearly free.

The same four run on every pull request (`ci.yml`), which is the point where a
failure is still cheap. Reaching them only on `push: main` means the break is
already on the branch the version PR is cut from, and undoing it costs another
PR. Apps are out of scope in both workflows: they are `private: true` and never
published, so they cannot break a consumer.

Both workflows pin their actions by **commit SHA**, with the version in a
trailing comment. Tags are mutable and `changesets/action@v1` is a branch, so
the unpinned form let someone else's push decide what ran in the job holding an
npm credential. Bump them like dependencies; the comment is what the bots read.

## Internal dependencies use `workspace:^`, not `workspace:*`

The distinction decides what a consumer's `node_modules` looks like, so it is
worth stating plainly. `pnpm publish` rewrites the workspace protocol at pack
time, and the two forms rewrite differently:

| in the repo | in the tarball |
| --- | --- |
| `workspace:*` | `"@intentface/latch-core": "0.1.0"` — **exact** |
| `workspace:^` | `"@intentface/latch-core": "^0.1.0"` — a range |

With exact pins, a consumer who declares `"@intentface/latch-core": "^0.1.0"`
and installs fresh after `0.1.1` ships resolves core to `0.1.1` at the top
level — while `latch-server@0.1.0` still demands exactly `0.1.0`. The resolver
satisfies both by nesting a **second copy of core**, with its own module
registry and its own `instanceof` identities. Nothing errors; things just stop
being the same class.

So every internal dependency in `packages/*` is `workspace:^`. The published
range overlaps the consumer's own range, and one copy of core serves both.
(Dev dependencies stay `workspace:*` — they are never published, so a range
there communicates nothing.)

### What this does not fix

A caret below 1.0.0 never spans minors: `^0.1.0` means `>=0.1.0 <0.2.0-0`, so
`0.2.0` does not satisfy it. Under lockstep every `minor` changeset opens a new
`0.x` line, so a consumer holding `latch-server@0.1.x` while resolving
`latch-core@0.2.0` duplicates core again, exactly as before.

**Below 1.0.0 this only dedupes patch releases within one minor line.** Two
consequences worth keeping in mind:

- Prefer `patch` over `minor` where the change honestly is one, since each minor
  starts a fresh line consumers must cross together.
- The durable fix is either reaching 1.0.0 (where `^1.2.0` spans every 1.x) or
  making `latch-core` a `peerDependency` of the packages that need one shared
  instance — the only mechanism that *guarantees* a single copy rather than
  making duplication unlikely.

**We stay below 1.0.0 deliberately**, until the public API is settled enough
that we would not want to change it. 1.0.0 is a promise about stability, not a
maturity badge, and making it early costs more than it buys.

So the second option is the one that matters: if duplicated `latch-core`
instances start biting real consumers before we are ready for 1.0, move core to
a `peerDependency` of the packages that need to share an instance. Until then,
prefer `patch` over `minor` wherever the change honestly is one — that is the
whole mitigation, and it is why this release ships as a patch.

Also note the caret is inert at `0.0.x` for the same reason: `^0.0.1` admits
only `0.0.1`. That is why this landed before the 0.1.0 release rather than
after — at 0.1.0 the ranges start meaning something.

## Lockstep versioning

Every package releases at the **same version** — `fixed: [["@intentface/latch-*"]]`
in `.changeset/config.json`.

Matching versions across the scope is what we build, test and ship, so it is the
combination to reach for — and below 1.0.0 it is still the only one that holds
across a minor bump, for the reason in the section above. It also keeps the
changelogs legible (one version, one story) and makes "upgrade the scope" a
single decision rather than a compatibility matrix.

## The release job installs only `packages/*`

`pnpm install --frozen-lockfile --filter "./packages/**" --filter "."` — the
release builds, tests and publishes libraries, so an app's dependencies aren't
needed. Purely a speed choice now.

(It used to be load-bearing. While the scope was mapped to GitHub Packages, a
full install died on `@intentface/chat` — published from another repository,
which this repo's `GITHUB_TOKEN` may not read. On the public registry that
resolves like any other dependency.)

## Trusted publishing, the way off the token treadmill

npm's OIDC flow ([trusted publishing](https://docs.npmjs.com/trusted-publishers/))
authenticates the workflow itself rather than a secret, so there is nothing to
rotate and nothing to leak. It works from a private repository. It is where this
should end up.

The catch is that it cannot perform a package's **first** publish: you authorize
a publisher in a package's settings on npmjs.com, and those settings do not
exist until the package does. Something else has to create the packages once.

1. **Bootstrap the ten packages.** Two ways, and the second stores nothing:

   - `NPM_TOKEN` in CI, as described above. Simple, and the 90-day clock never
     matters because the token is revoked at step 4.
   - **One publish from a laptop.** `npm login` issues a two-hour session that
     satisfies 2FA, then `pnpm release` runs the same four gates CI does
     (typecheck, test, build, `verify:publish`) and publishes the current
     version of every package. Nothing long-lived is created, and no secret ever
     enters the repository.

2. **Authorize the workflow on each package**: a trusted publisher pointing at
   `Intentface/intentface-latch`, workflow `release.yml` (the filename must
   match exactly, extension included). `npm trust github` does this from the
   terminal instead of ten trips through the web UI.
3. **Switch `release.yml` to OIDC**: add `id-token: write` to `permissions` and
   a step that upgrades the npm CLI (`npm install -g npm@latest`) — OIDC needs
   11.5.1 or later and the CLI bundled with `setup-node` is older. GitHub-hosted
   runners only; self-hosted cannot mint the token.
4. **Remove the credential**: delete the `NODE_AUTH_TOKEN` line, and the
   `NPM_TOKEN` secret if you created one.

From then on a release is the same two merges, authenticated by the workflow's
own identity, with nothing to rotate.

## Provenance is off, and why

npm can sign each tarball against the workflow run that built it, which is what
puts the verified badge and a source link on the package page. We don't, because
npm [stopped accepting provenance from private source
repositories](https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/)
in July 2023. Enabling it here would not degrade quietly — the registry rejects
the attestation and the publish fails.

This is a property of the repository, not of the token: provenance stays
unavailable under trusted publishing too, which npm skips rather than fails on.

If this repository ever goes public, it becomes a two-line change: add
`id-token: write` to the job's `permissions` and `NPM_CONFIG_PROVENANCE: "true"`
to the publish step's environment. The third prerequisite, a `repository` field
with a `directory` in every manifest, is already enforced by
`verify:publish`.

## One license, copied by pnpm

There is a single `LICENSE` at the workspace root, and no per-package copies.
`pnpm pack` copies the root license into every package tarball, so the copies
would only be something to keep in sync.

That convenience belongs to pnpm, not to npm. Publish with bare `npm publish`
and the tarballs would claim MIT while shipping no license text — which is why
`verify:publish` reads the license out of the packed tarball and compares it to
the root, rather than checking that a file sits in the directory.

## Consuming the packages

```bash
pnpm add @intentface/latch-core @intentface/latch-drizzle ai
```

No `.npmrc`, no token, no registry mapping. `ai` is a peer dependency of nearly
every package in the scope, so a consumer always declares it themselves.

## Why `publishConfig.exports` exists

Each package's `exports` map carries a `development` condition pointing at
`./src/*.ts`, so workspace consumers get live source with no build step. But
`files` is `["dist"]` — `src` is **not** in the tarball. A consumer whose bundler
resolves the `development` condition (Vite in dev mode, for one) would try to
import a file that doesn't exist.

So every package ships a `publishConfig.exports` that mirrors `exports` with the
`development` condition stripped; pnpm swaps it in at pack time. Verified by
packing and reading the tarball's manifest.

**If you add or change an `exports` entry, update `publishConfig.exports` to
match.** They are two copies of the same map and nothing enforces agreement — a
`development`-only entry in the published map is a module-not-found for every
consumer, and it will not show up anywhere in this monorepo.

## Publishability checklist

Before adding a new package to the scope:

- `files` includes everything the `exports` map points at
- `publishConfig.exports` mirrors `exports`, without `development`
- internal `@intentface/latch-*` dependencies are `workspace:^`, not
  `workspace:*` — see above; `*` publishes an exact pin and duplicates the
  dependency in consumer installs
- `repository.directory` points at the package (npm renders the source link
  from it, and provenance attestation needs it)
- `private: true` if it isn't meant to be published — `latch-renderer` is a
  deployable service, not a library, and is marked private for that reason
- peer dependency ranges agree with the rest of the scope
- `publishConfig.registry` is `https://registry.npmjs.org` and
  `publishConfig.access` is `public` — a scoped package defaults to restricted,
  and the first publish would otherwise land private

Verify by packing and reading what actually ships:

```bash
cd packages/<name>
pnpm pack --pack-destination /tmp
tar -xzOf /tmp/intentface-latch-<name>-<version>.tgz package/package.json
```
