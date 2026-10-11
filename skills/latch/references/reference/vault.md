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

`createVault` throws if `masterKey` isn't 32 bytes. `deriveMasterKey(passphrase, { salt })` from `@intentface/latch-core/node` derives one from a passphrase (Node only; the salt must be stable for the deployment).

## Methods

| Option | Type | Description |
| --- | --- | --- |
| `set` | `(principal: P, key: string, value: string) => Promise<void>` | Saves a secret, encrypted, replacing any value under that key. This is also how you rotate one. |
| `get` | `(principal: P, key: string) => Promise<string \| undefined>` | The secret's value, or `undefined` if there is none. Use it in your server code and tools; never return it to the model or the browser. |
| `has` | `(principal: P, key: string) => Promise<boolean>` | Whether a secret is set, without decrypting it. For a settings page's "connected" state. |
| `delete` | `(principal: P, key: string) => Promise<void>` | Removes a secret. Nothing that used it can read it afterwards. |
| `list` | `(principal: P) => Promise<string[]>` | The keys set for this owner. Names only, never values. |
| `resolver` | `SecretResolver<P>` | `get` as a function, for what takes a resolver: `createMcpConnections({ secrets: vault.resolver })`. |

## Secret store

`createPostgresSecretStore(db, { owner })` and `createSqliteSecretStore(db, { owner })` keep the encrypted records in `latch_secrets`. `owner(principal, key?)` returns the owner's segments, and receives the secret's key so different kinds of secret can belong to different owners. `list` has no key to pass, so it lists the owner `owner(principal)` gives without one.

A store of your own implements:

| Option | Type | Description |
| --- | --- | --- |
| `put` | `(principal: P, record: SecretRecord) => Promise<void>` | Saves an encrypted record for this owner, replacing one with the same key. |
| `get` | `(principal: P, key: string) => Promise<SecretRecord \| null>` | This owner's record for the key, or `null`. |
| `delete` | `(principal: P, key: string) => Promise<void>` | Removes this owner's record for the key. |
| `list` | `(principal: P) => Promise<string[]>` | This owner's keys, never values. |
| `purgeOwner` (optional) | `((segments: string[], opts?: { batchSize?: number; }) => Promise<PurgeResult>)` | OPTIONAL. Delete everything this store keeps (every secret under it) for an owner path, in passes (see `StorageAdapter.purgeOwner`): call until `done`. Without it, `runtime.purgeOwner` refuses when this store is passed to it. |

It only ever handles encrypted records; values are encrypted and decrypted in `createVault`.
