# Releasing

The `@intentface/latch-*` packages publish to the **public npm registry**.
Everything is driven by
[changesets](https://github.com/changesets/changesets); no one runs
`npm publish` by hand.

**Publishing stores no credential.** The workflow authenticates as itself
through npm's OIDC [trusted publishing](https://docs.npmjs.com/trusted-publishers/),
so there is no `NPM_TOKEN` secret, nothing to rotate and nothing to leak.

Getting there took one manual publish, because OIDC cannot create a package that
does not exist yet — see
[Trusted publishing](#trusted-publishing-and-the-one-manual-publish). That is
done; nobody should need to repeat it.

Tokens are not the fallback they used to be. Classic and automation tokens were
[revoked in December 2025](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/).
Their replacement, a granular token with 2FA bypass, is itself being retired:
since early August 2026 it can no longer manage tokens or 2FA settings, and
[around January 2027 it loses the ability to publish at all](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
leaving only reads and staged publishes awaiting human approval. OIDC is not
merely the tidier option; it is the one with a future.

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

## Trusted publishing, and the one manual publish

OIDC cannot perform a package's **first** publish. You authorize a publisher in
a package's settings on npmjs.com, and those settings do not exist until the
package does — `npm trust` says so plainly: *"The package you're configuring
must already exist on the npm registry."* So something has to create the ten
packages once, and it cannot be the workflow.

That something was a laptop, not a token, and the reason is worth recording so
nobody re-litigates it: **`npm trust` does not accept a 2FA-bypass token
either.** Its documented constraints are *"Two-factor authentication must be
enabled at the account level"* and *"Granular Access Tokens (GAT) with the
bypass 2FA option are not supported."* An interactive, 2FA-backed session is
therefore unavoidable at step 2 whatever you do at step 1 — so a publish token
never removes a manual step, it only adds a credential to the repository.

1. **Publish once by hand.** `npm login` issues a session that satisfies 2FA.
   `pnpm release` then runs the same four gates CI does (typecheck, test, build,
   `verify:publish`) before `changeset publish`, so the packages that reach the
   registry are the ones that passed. It also writes a git tag per package —
   push them (`git push --follow-tags`).
2. **Authorize the workflow on each package.** One command per package, from a
   terminal logged in with `npm login` (npm@11.15.0 or later):

   ```bash
   npm trust github @intentface/latch-core \
     --repo Intentface/intentface-latch \
     --file release.yml \
     --allow-publish
   ```

   The workflow filename must match exactly, extension included. npmjs.com
   offers a "skip two-factor authentication for the next 5 minutes" window,
   which is what makes ten of these bearable. `npm trust list <package>` shows
   what is configured, including the relationship id that
   `npm trust revoke <package> --id=<trust-id>` needs to remove one.
3. **The workflow is already OIDC.** `id-token: write` is in `permissions`, the
   npm CLI is upgraded to a pinned 11.18.0 before the publish step (OIDC needs
   11.5.1 or later; the CLI bundled with `setup-node` is older, and `@latest`
   is npm 12, which demands Node ^22.22.2 || ^24.15.0 || >=26), and no
   `NODE_AUTH_TOKEN` is set. GitHub-hosted runners only — self-hosted cannot
   mint the token.

From then on a release is the same two merges, authenticated by the workflow's
own identity, with nothing to rotate.

Two wrinkles from the first releases. 0.9.1 was published by hand before its
version PR merged, so the workflow found nothing to publish and created no tags
or GitHub Releases for it. 0.10.0 was published by the workflow — the first OIDC
publish — but `changesets/action` v1 detected published packages by parsing
`New tag:` lines out of stdout, which `@changesets/cli` v3 no longer prints, so
it pushed no tags and created no releases either; those tags were pushed by
hand. The workflow now runs v2, which reads an output file, and every release
from here gets tags and releases from the workflow itself.

## Published metadata points at nothing, on purpose

The manifests carry `repository` (npm wants it, and provenance will need it)
but no `homepage` or `bugs`. Both would have pointed into a private repository,
so every consumer clicking "Homepage" or "Issues" from the npm page would get a
404. Better to advertise nothing than a door that does not open. Add them back
the day there is a public destination — a docs site, or this repository going
public.

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
