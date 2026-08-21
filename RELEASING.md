# Releasing

The `@intentface/latch-*` packages publish to **GitHub Packages**
(`https://npm.pkg.github.com`), not the public npm registry. Everything is
driven by [changesets](https://github.com/changesets/changesets); no one runs
`npm publish` by hand.

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
   changesets, and publishes to GitHub Packages.

So a release is always two merges: your change, then the version PR. Nothing
publishes straight off a feature merge.

`pnpm release` runs `typecheck:packages`, `test`, `build` and `verify:publish`
before `changeset publish`, so publishing unverified packages isn't possible even
by invoking it directly. The workflow also runs those four as separate steps —
for legible CI output, and so a failure lands before the changesets action starts.
Turbo caches, so the duplication is nearly free.

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

## Lockstep versioning

Every package releases at the **same version** — `fixed: [["@intentface/latch-*"]]`
in `.changeset/config.json`.

Matching versions across the scope is what we build, test and ship, so it is the
combination to reach for. It is no longer the *only* safe one — that is what the
caret ranges above are for — but it keeps the changelogs legible (one version,
one story) and it means "upgrade the scope" is a single decision rather than a
compatibility matrix.

## The release job installs only `packages/*`

`pnpm install --frozen-lockfile --filter "./packages/**" --filter "."` — the
release builds, tests and publishes libraries, so an app's dependencies aren't
needed.

That filter is load-bearing. `apps/latch-platform` depends on
`@intentface/chat`, published from a **different repository**. The workflow maps
the whole `@intentface` scope to GitHub Packages, and the default `GITHUB_TOKEN`
is scoped to *this* repo — so it can't read a package owned by another one, and a
full install fails with `ERR_PNPM_FETCH_403`. (403, not 404: the package exists,
the token just isn't allowed to fetch it.)

If a package under `packages/*` ever takes a cross-repo `@intentface`
dependency, either grant this repository read access to that package in its
GitHub Packages settings, or replace `GITHUB_TOKEN` with a PAT carrying
`read:packages`.

## Consuming the packages

```ini title=".npmrc"
@intentface:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The token needs **`read:packages`** and nothing more. In GitHub Actions inside
this organization the default `GITHUB_TOKEN` suffices; anywhere else (Vercel, Fly,
a Docker build) set it as a build secret, or installs fail with a `401` that
reads like a missing package.

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
- `repository.directory` points at the package (GitHub Packages links the
  package to the repo through this)
- `private: true` if it isn't meant to be published — `latch-renderer` is a
  deployable service, not a library, and is marked private for that reason
- peer dependency ranges agree with the rest of the scope

Verify by packing and reading what actually ships:

```bash
cd packages/<name>
pnpm pack --pack-destination /tmp
tar -xzOf /tmp/intentface-latch-<name>-<version>.tgz package/package.json
```
