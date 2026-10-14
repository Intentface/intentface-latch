---
"@intentface/latch-core": minor
"@intentface/latch-drizzle": minor
---

Vault master key rotation, and secrets tied to their owner.

- `createVault({ masterKey: { id, key }, previousKeys: [{ id, key }] })`: name each master key, and keep old ones readable while rotating. A plain string key still works, with the id `default`.
- `vault.rotate({ batchSize? })` (on `RotatableVault`, what `createVault` now returns; `Vault` is unchanged, so wrappers around one keep compiling) moves every secret onto the current key by re-wrapping its data key (values aren't re-encrypted). Safe to run again or stop part-way; a secret saved again while it runs is left as saved. Returns `{ checked, rewrapped, remaining, errors }`; at `remaining: 0` the old keys can go.
- New secrets record their key id in `wrappedDek` (`v2:<keyId>:<binding>:…`, no schema change) and are bound to their owner key and name, so a record copied into another owner's row no longer decrypts. Secrets saved before stay readable after upgrading, and `rotate()` binds them. Older versions can't read secrets saved by this one: after upgrading, don't roll back to 0.20 or earlier, and expect an instance still on the old version mid-deploy to fail on secrets saved in that window.
- A master key can live in a key service: pass a `VaultKeyProvider` (`{ id, wrap, unwrap }`) that calls AWS KMS, Google Cloud KMS, HashiCorp Vault or your HSM. It gets each secret's data key and an encryption context naming the secret and its owner; the key never reaches your app. `rotate()` moves secrets onto it from a key held here.
- `SecretStore` gains optional `ownerKeyOf`, `scan` and `replaceWrap`; the Postgres and SQLite secret stores implement them. Without `scan` and `replaceWrap`, `rotate()` throws `UnsupportedOperationError`.
- `deriveMasterKey(passphrase, { salt, cost })` takes scrypt's N. The default stays `2 ** 14` so existing keys don't change; use `2 ** 17` for new deployments.
