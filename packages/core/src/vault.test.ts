import { describe, expect, it } from "vitest";
import { isUnsupportedOperationError } from "./storage.js";
import { createVault, type SecretRecord, type SecretStore, type StoredSecret, type VaultKeyProvider } from "./vault.js";
import { deriveMasterKey } from "./vault-node.js";

type P = { user: string };

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const K1 = newKey();
const K2 = newKey();

/** A store as the shipped ones behave: rows keyed by owner and name. `full: false` is a minimal custom store. */
function memoryStore(opts: { full?: boolean } = {}) {
  const rows = new Map<string, StoredSecret>();
  const owner = (p: P) => `u:${p.user}`;
  const id = (o: string, key: string) => `${o}:${key}`;
  const store: SecretStore<P> = {
    async put(p, r) {
      rows.set(id(owner(p), r.key), { ...r, owner: owner(p) });
    },
    async get(p, key) {
      const r = rows.get(id(owner(p), key));
      if (!r) return null;
      const { owner: _, ...record } = r;
      return record;
    },
    async delete(p, key) {
      rows.delete(id(owner(p), key));
    },
    async list(p) {
      return [...rows.values()].filter((r) => r.owner === owner(p)).map((r) => r.key);
    },
  };
  if (opts.full !== false) {
    store.ownerKeyOf = (p) => owner(p);
    store.scan = async ({ after, limit }) => {
      const ids = [...rows.keys()].sort().filter((k) => after === undefined || k > after).slice(0, limit);
      return { records: ids.map((k) => ({ ...rows.get(k)! })), next: ids.length === limit ? ids.at(-1) : undefined };
    };
    store.replaceWrap = async (o, key, wrap, expected) => {
      const r = rows.get(id(o, key));
      if (!r || r.wrappedDek !== expected) return false;
      rows.set(id(o, key), { ...r, ...wrap });
      return true;
    };
  }
  return { store, rows };
}

/** A record as vaults before key ids wrote it: plain base64 wrap, no additional data. */
async function legacyRecord(masterKey: string, key: string, value: string): Promise<SecretRecord> {
  const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64");
  const kek = await crypto.subtle.importKey("raw", Buffer.from(masterKey, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(value));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: dekIv }, kek, await crypto.subtle.exportKey("raw", dek));
  return { key, ciphertext: b64(ciphertext), iv: b64(iv), wrappedDek: b64(wrapped), dekIv: b64(dekIv), createdAt: 1, updatedAt: 1 };
}

const alice: P = { user: "alice" };
const bob: P = { user: "bob" };

describe("createVault", () => {
  it("reads records written before key ids, with the key as a plain string or in previousKeys", async () => {
    const { store } = memoryStore();
    await store.put(alice, await legacyRecord(K1, "token", "s3cret"));

    expect(await createVault({ store, masterKey: K1 }).get(alice, "token")).toBe("s3cret");
    const rotated = createVault({ store, masterKey: { id: "k2", key: K2 }, previousKeys: [{ id: "k1", key: K1 }] });
    expect(await rotated.get(alice, "token")).toBe("s3cret");
  });

  it("writes new secrets under the current key id, bound to their owner", async () => {
    const { store, rows } = memoryStore();
    const vault = createVault({ store, masterKey: { id: "k1", key: K1 } });
    await vault.set(alice, "token", "s3cret");

    expect(rows.get("u:alice:token")!.wrappedDek).toMatch(/^v2:k1:o:/);
    expect(await vault.get(alice, "token")).toBe("s3cret");
    expect(await createVault({ store, masterKey: K1 }).get(alice, "token")).toBe("s3cret"); // same key, renamed: still opens
  });

  it("binds to the name only when the store can't say its owner key", async () => {
    const { store, rows } = memoryStore({ full: false });
    const vault = createVault({ store, masterKey: K1 });
    await vault.set(alice, "token", "s3cret");

    expect(rows.get("u:alice:token")!.wrappedDek).toMatch(/^v2:default:n:/);
    expect(await vault.get(alice, "token")).toBe("s3cret");
  });

  it("won't open a bound secret copied into another owner's row, or under another name", async () => {
    const { store, rows } = memoryStore();
    const vault = createVault({ store, masterKey: K1 });
    await vault.set(alice, "token", "alice's");
    const { owner: _, ...record } = rows.get("u:alice:token")!;

    await store.put(bob, record);
    await expect(vault.get(bob, "token")).rejects.toThrow(/moved or altered/);
    await store.put(alice, { ...record, key: "other" });
    await expect(vault.get(alice, "other")).rejects.toThrow(/moved or altered/);
  });

  it("names the key when the one a secret was wrapped with isn't configured", async () => {
    const { store } = memoryStore();
    await createVault({ store, masterKey: { id: "k1", key: K1 } }).set(alice, "token", "s3cret");

    await expect(createVault({ store, masterKey: { id: "k2", key: K2 } }).get(alice, "token")).rejects.toThrow(/secret "token", wrapped by key "k1"/);
  });

  it("refuses malformed keys and ids", () => {
    const { store } = memoryStore();
    expect(() => createVault({ store, masterKey: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(() => createVault({ store, masterKey: { id: "k:1", key: K1 } })).toThrow(/letters, digits/);
    expect(() => createVault({ store, masterKey: { id: "k", key: K1 }, previousKeys: [{ id: "k", key: K2 }] })).toThrow(/used twice/);
  });
});

describe("vault.rotate", () => {
  it("moves every secret onto the current key, values unchanged, and finds nothing left the second time", async () => {
    const { store, rows } = memoryStore();
    await store.put(alice, await legacyRecord(K1, "legacy", "old"));
    const v1 = createVault({ store, masterKey: { id: "k1", key: K1 } });
    for (let i = 0; i < 5; i++) await v1.set(bob, `t${i}`, `value ${i}`);

    const v2 = createVault({ store, masterKey: { id: "k2", key: K2 }, previousKeys: [{ id: "k1", key: K1 }] });
    const first = await v2.rotate({ batchSize: 2 });

    expect(first).toEqual({ checked: 6, rewrapped: 6, remaining: 0, errors: [] });
    expect([...rows.values()].every((r) => r.wrappedDek.startsWith("v2:k2:o:"))).toBe(true);
    const k2Only = createVault({ store, masterKey: { id: "k2", key: K2 } });
    expect(await k2Only.get(alice, "legacy")).toBe("old");
    expect(await k2Only.get(bob, "t3")).toBe("value 3");
    expect(await v2.rotate()).toEqual({ checked: 6, rewrapped: 0, remaining: 0, errors: [] });
  });

  it("leaves a secret saved during the rotation as it was saved", async () => {
    const { store } = memoryStore();
    const v1 = createVault({ store, masterKey: { id: "k1", key: K1 } });
    await v1.set(alice, "token", "before");
    const v2 = createVault({ store, masterKey: { id: "k2", key: K2 }, previousKeys: [{ id: "k1", key: K1 }] });
    const replaceWrap = store.replaceWrap!;
    store.replaceWrap = async (...args) => {
      await v1.set(alice, "token", "after"); // another instance, still on k1, saves it again
      return replaceWrap(...args);
    };

    const result = await v2.rotate();

    expect(result).toMatchObject({ rewrapped: 0, remaining: 1 });
    expect(await v2.get(alice, "token")).toBe("after");
  });

  it("reports a secret no configured key opens, and rotates the rest", async () => {
    const { store } = memoryStore();
    await createVault({ store, masterKey: { id: "lost", key: newKey() } }).set(alice, "a", "x");
    await createVault({ store, masterKey: { id: "k1", key: K1 } }).set(bob, "b", "y");

    const result = await createVault({ store, masterKey: { id: "k2", key: K2 }, previousKeys: [{ id: "k1", key: K1 }] }).rotate();

    expect(result).toMatchObject({ checked: 2, rewrapped: 1, remaining: 1 });
    expect(result.errors).toEqual([expect.objectContaining({ owner: "u:alice", key: "a" })]);
  });

  it("reports a record with a malformed wrap, and rotates the rest", async () => {
    const { store, rows } = memoryStore();
    const v1 = createVault({ store, masterKey: { id: "k1", key: K1 } });
    await v1.set(alice, "a", "x");
    await v1.set(bob, "b", "y");
    rows.get("u:alice:a")!.wrappedDek = "v2:k1:z:AAAA"; // not a binding the vault writes

    const result = await createVault({ store, masterKey: { id: "k2", key: K2 }, previousKeys: [{ id: "k1", key: K1 }] }).rotate();

    expect(result).toMatchObject({ checked: 2, rewrapped: 1, remaining: 1 });
    expect(result.errors).toEqual([expect.objectContaining({ owner: "u:alice", key: "a" })]);
  });

  it("refuses with a store that can't list and replace records", async () => {
    const { store } = memoryStore({ full: false });
    const error = await createVault({ store, masterKey: K1 }).rotate().catch((e: unknown) => e);
    expect(isUnsupportedOperationError(error)).toBe(true);
  });
});

/**
 * A stand-in for a key service: the key never leaves it, and like AWS KMS it
 * refuses to decrypt under any other encryption context.
 */
function fakeKeyService(id: string) {
  const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const contexts: Record<string, string>[] = [];
  const aad = (context: Record<string, string>) => new TextEncoder().encode(JSON.stringify(Object.entries(context).sort()));
  const provider: VaultKeyProvider = {
    id,
    async wrap(dataKey, { context }) {
      contexts.push(context);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context) }, await key, dataKey);
      return new Uint8Array([...iv, ...new Uint8Array(out)]);
    },
    async unwrap(wrapped, { context }) {
      const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapped.slice(0, 12), additionalData: aad(context) }, await key, wrapped.slice(12));
      return new Uint8Array(out);
    },
  };
  return { provider, contexts };
}

describe("a master key in a key service", () => {
  it("wraps and unwraps through it, bound to the owner and the secret", async () => {
    const { store, rows } = memoryStore();
    const kms = fakeKeyService("kms-1");
    const vault = createVault({ store, masterKey: kms.provider });
    await vault.set(alice, "token", "s3cret");

    expect(rows.get("u:alice:token")).toMatchObject({ wrappedDek: expect.stringMatching(/^v2:kms-1:o:/), dekIv: "" });
    expect(kms.contexts).toEqual([{ vault: "latch-vault/v2", secret: "token", owner: "u:alice" }]);
    expect(await vault.get(alice, "token")).toBe("s3cret");

    const { owner: _, ...record } = rows.get("u:alice:token")!;
    await store.put(bob, record);
    await expect(vault.get(bob, "token")).rejects.toThrow();
  });

  it("takes secrets over from a key held here, with rotate", async () => {
    const { store } = memoryStore();
    const local = { id: "k1", key: K1 };
    await createVault({ store, masterKey: local }).set(alice, "token", "s3cret");
    const kms = fakeKeyService("kms-1");

    expect(await createVault({ store, masterKey: kms.provider, previousKeys: [local] }).rotate()).toMatchObject({ rewrapped: 1, remaining: 0 });
    expect(await createVault({ store, masterKey: kms.provider }).get(alice, "token")).toBe("s3cret");
  });

  it("passes on the service's own error", async () => {
    const { store } = memoryStore();
    const kms = fakeKeyService("kms-1");
    await createVault({ store, masterKey: kms.provider }).set(alice, "token", "s3cret");
    const down: VaultKeyProvider = { ...kms.provider, unwrap: () => Promise.reject(new Error("KMS: AccessDeniedException")) };

    await expect(createVault({ store, masterKey: down }).get(alice, "token")).rejects.toThrow(/AccessDeniedException/);
  });
});

describe("deriveMasterKey", () => {
  it("derives the same key as before by default, and a different one with a higher cost", () => {
    const base = deriveMasterKey("passphrase", { salt: "deploy-1" });
    expect(base).toBe(deriveMasterKey("passphrase", { salt: "deploy-1", cost: 2 ** 14 }));
    expect(Buffer.from(base, "base64")).toHaveLength(32);
    expect(deriveMasterKey("passphrase", { salt: "deploy-1", cost: 2 ** 17 })).not.toBe(base);
    expect(() => deriveMasterKey("passphrase", { salt: "deploy-1", cost: 1000 })).toThrow(/power of two/);
  });
});
