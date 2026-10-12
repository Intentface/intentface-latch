<!-- Generated from apps/docs/content/docs/reference/vault.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Vault

createVault, its methods, and the secret store it keeps encrypted records in.

Online: https://intentface-latch-docs.vercel.app/docs/reference/vault

What the vault is for and how to use it: [Secrets (the vault)](../concepts/secrets.md).

```ts
import { createVault } from "@intentface/latch-core";
import { createPostgresSecretStore } from "@intentface/latch-drizzle";

const vault = createVault<Principal>({
  store: createPostgresSecretStore(db, { owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]) }),
  masterKey: process.env.LATCH_VAULT_KEY!, // base64 of 32 random bytes
});
```

`createVault` throws if a key isn't 32 bytes, or a key id isn't letters, digits, `_` and `-` (up to 32), or two keys share an id.

| Option | |
| --- | --- |
| `store` | Where the encrypted records live (below). |
| `masterKey` | The key new secrets are saved under: base64 of 32 random bytes, `{ id, key }`, or a `VaultKeyProvider` that calls your key service. A plain string has the id `default`. |
| `previousKeys` | Keys, in either form, that still read secrets but never save new ones. Keep the old key here while rotating. |

Each saved secret records the id of the key it was saved under, in `wrappedDek`. A secret is read with that key when it's configured, and otherwise with whichever configured key opens it. Rotating is described in [Secrets](../concepts/secrets.md#rotating-the-master-key).

A key in a key service (example in [Secrets](../concepts/secrets.md#a-master-key-in-a-key-service)):

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Letters, digits, `_` and `-`, up to 32: recorded with every secret it wraps. |
| `wrap` | `(dataKey: Uint8Array<ArrayBuffer>, binding: VaultKeyBinding) => Promise<Uint8Array>` | Encrypt a 32-byte data key. Bind it to `binding` (the service's encryption context or additional data). |
| `unwrap` | `(wrapped: Uint8Array<ArrayBuffer>, binding: VaultKeyBinding) => Promise<Uint8Array>` | Decrypt what `wrap` returned. Must throw, not return something else, when the bytes weren't wrapped by this key with this same `binding`: that's what stops a secret copied into another owner's row from opening there. |

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, string>` | As an encryption context (AWS KMS `EncryptionContext`): `vault`, `secret` and, when the store says it, `owner`. |
| `aad` | `Uint8Array<ArrayBufferLike>` | The same, as bytes, for services that take additional authenticated data (Google Cloud KMS, AES-GCM). |

A record whose key id isn't configured is tried against the keys held here, never against a key service.

`deriveMasterKey(passphrase, { salt, cost? })` from `@intentface/latch-core/node` derives a key from a passphrase (Node only). `salt` must be stable for the deployment. `cost` is scrypt's N, a power of two from `2 ** 14` (the default, kept so existing keys don't change) to `2 ** 20`; use `2 ** 17` for a new deployment. A different cost gives a different key.

## Methods

| Option | Type | Description |
| --- | --- | --- |
| `set` | `(principal: P, key: string, value: string) => Promise<void>` | Saves a secret, encrypted, replacing any value under that key. This is also how you rotate one. |
| `get` | `(principal: P, key: string) => Promise<string \| undefined>` | The secret's value, or `undefined` if there is none. Use it in your server code and tools; never return it to the model or the browser. |
| `has` | `(principal: P, key: string) => Promise<boolean>` | Whether a secret is set, without decrypting it. For a settings page's "connected" state. |
| `delete` | `(principal: P, key: string) => Promise<void>` | Removes a secret. Nothing that used it can read it afterwards. |
| `list` | `(principal: P) => Promise<string[]>` | The keys set for this owner. Names only, never values. |
| `resolver` | `SecretResolver<P>` | `get` as a function, for what takes a resolver: `createMcpConnections({ secrets: vault.resolver })`. |
| `rotate` | `(opts?: { batchSize?: number; }) => Promise<{ checked: number; rewrapped: number; remaining: number; errors: { owner: string; key: string; error: unknown; }[]; }>` | Re-wraps every secret not yet under the current master key (and binding) onto it. Values aren't re-encrypted, so it's quick. Run it after adding a new `masterKey` with the old one in `previousKeys`; when it reports `remaining: 0`, nothing needs the old keys any more and you can remove them. Safe to run again or stop part-way. Needs a store with `scan` and `replaceWrap` (the shipped ones have them); throws `UnsupportedOperationError` otherwise. |

## Secret store

`createPostgresSecretStore(db, { owner })` and `createSqliteSecretStore(db, { owner })` keep the encrypted records in `latch_secrets`. `owner(principal, key?)` returns the owner's segments, and receives the secret's key so different kinds of secret can belong to different owners. `list` has no key to pass, so it lists the owner `owner(principal)` gives without one.

They also implement `ownerKeyOf`, `scan` and `replaceWrap`, so secrets are tied to their owner and `vault.rotate()` works. A store of your own implements:

| Option | Type | Description |
| --- | --- | --- |
| `put` | `(principal: P, record: SecretRecord) => Promise<void>` | Saves an encrypted record for this owner, replacing one with the same key. |
| `get` | `(principal: P, key: string) => Promise<SecretRecord \| null>` | This owner's record for the key, or `null`. |
| `delete` | `(principal: P, key: string) => Promise<void>` | Removes this owner's record for the key. |
| `list` | `(principal: P) => Promise<string[]>` | This owner's keys, never values. |
| `purgeOwner` (optional) | `((segments: string[], opts?: { batchSize?: number; }) => Promise<PurgeResult>)` | OPTIONAL. Delete everything this store keeps (every secret under it) for an owner path, in passes (see `StorageAdapter.purgeOwner`): call until `done`. Without it, `runtime.purgeOwner` refuses when this store is passed to it. |
| `ownerKeyOf` (optional) | `((principal: P, key: string) => string)` | OPTIONAL. The owner key this store files `key` under for this principal: the same value it stores in the row. With it, the vault binds each secret to its owner, so a record moved into another owner's row won't decrypt; without it, only to the secret's name. |
| `scan` (optional) | `((opts: { after?: string; limit: number; }) => Promise<{ records: StoredSecret[]; next?: string; }>)` | OPTIONAL system op, for `vault.rotate()`: every record, with the owner key it's stored under, in pages ordered by a stable cursor. |
| `replaceWrap` (optional) | `((owner: string, key: string, wrap: Pick<SecretRecord, "wrappedDek" \| "dekIv">, expectedWrappedDek: string) => Promise<boolean>)` | OPTIONAL system op, for `vault.rotate()`: replace a record's wrapped data key, only while it still has `expectedWrappedDek` (a secret saved again in the meantime keeps its new value). Returns whether it applied. |

It only ever handles encrypted records; values are encrypted and decrypted in `createVault`. Without `ownerKeyOf`, secrets are tied to their name only, so a record copied into another owner's row would still open there. Without `scan` and `replaceWrap`, `rotate()` throws `UnsupportedOperationError`.
