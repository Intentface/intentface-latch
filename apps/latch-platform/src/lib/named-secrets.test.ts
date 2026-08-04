import type { Vault } from "@intentface/latch-core";
import { describe, expect, it } from "vitest";
import { createNamedSecrets, normalizeSecretName, resolveSecretRef } from "./named-secrets";
import type { Principal } from "./session";

/** In-memory Vault stub keyed exactly like the real owner derivation. */
function memoryVault(): Vault<Principal> {
  const data = new Map<string, string>();
  const k = (p: Principal, key: string) => `${p.orgId}/${p.userId ?? ""}:${key}`;
  return {
    set: async (p: Principal, key: string, value: string) => void data.set(k(p, key), value),
    get: async (p: Principal, key: string) => data.get(k(p, key)),
    has: async (p: Principal, key: string) => data.has(k(p, key)),
    delete: async (p: Principal, key: string) => void data.delete(k(p, key)),
    list: async (p: Principal) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${p.orgId}/${p.userId ?? ""}:`))
        .map((key) => key.slice(`${p.orgId}/${p.userId ?? ""}:`.length)),
    resolver: { get: async () => undefined },
  } as unknown as Vault<Principal>;
}

const alice: Principal = { orgId: "org1", userId: "alice" };
const bob: Principal = { orgId: "org1", userId: "bob" };
const otherOrg: Principal = { orgId: "org2", userId: "alice" };

describe("normalizeSecretName", () => {
  it("keeps a name safe to use as a vault key and a tool argument", () => {
    expect(normalizeSecretName("  strava client secret ")).toBe("strava_client_secret");
    expect(normalizeSecretName("api/key?v=2")).toBe("api_key_v_2");
    expect(normalizeSecretName("already_fine-1")).toBe("already_fine-1");
  });
});

describe("createNamedSecrets", () => {
  it("stores and reads back a value at user scope", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "strava_client_secret", "user", "s3cret");
    expect(await secrets.get(alice, "strava_client_secret", "user")).toBe("s3cret");
    expect(await secrets.has(alice, "strava_client_secret", "user")).toBe(true);
  });

  it("isolates personal secrets between members of the same org", async () => {
    // The whole point of the owner key: bob's agents must not resolve alice's
    // personally-entered credential.
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "k", "user", "alice-value");
    expect(await secrets.get(bob, "k", "user")).toBeUndefined();
    expect(await secrets.list(bob)).toEqual([]);
  });

  it("isolates secrets across orgs even for the same user id", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "k", "user", "org1-value");
    expect(await secrets.get(otherOrg, "k", "user")).toBeUndefined();
  });

  it("shares org-scoped secrets across members but keeps them off the user scope", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "shared", "org", "org-value");
    expect(await secrets.get(bob, "shared", "org")).toBe("org-value");
    // Same name at user scope is a different secret entirely.
    expect(await secrets.get(alice, "shared", "user")).toBeUndefined();
  });

  it("lists names and scopes only — never values", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "personal", "user", "p-value");
    await secrets.set(alice, "shared", "org", "o-value");
    const listed = await secrets.list(alice);
    expect(listed).toEqual([
      { name: "shared", scope: "org" },
      { name: "personal", scope: "user" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("p-value");
    expect(JSON.stringify(listed)).not.toContain("o-value");
  });

  it("does not list unrelated vault entries", async () => {
    // The vault also holds `connection:*`, `conn:*:apikey`, `oauth2:*` blobs;
    // the prefix filter is what keeps those out of the Secrets UI.
    const vault = memoryVault();
    await vault.set(alice, "connection:strava", "{}");
    await vault.set(alice, "conn:x:apikey", "tok");
    const secrets = createNamedSecrets(vault);
    await secrets.set(alice, "mine", "user", "v");
    expect(await secrets.list(alice)).toEqual([{ name: "mine", scope: "user" }]);
  });

  it("removes a secret at its scope only", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "k", "user", "u");
    await secrets.set(alice, "k", "org", "o");
    await secrets.remove(alice, "k", "user");
    expect(await secrets.get(alice, "k", "user")).toBeUndefined();
    expect(await secrets.get(alice, "k", "org")).toBe("o");
  });
});

describe("resolveSecretRef", () => {
  it("resolves a stored name to its value for the server-side write", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "strava_client_secret", "user", "s3cret");
    expect(
      await resolveSecretRef(secrets, alice, "strava_client_secret", "user", "clientSecretRef"),
    ).toEqual({ ok: true, value: "s3cret" });
  });

  it("treats an absent ref as 'keep whatever is stored'", async () => {
    // create_connection omits the ref on an edit; that must not be an error, it
    // must fall through to upsertConnection's carry-over.
    const secrets = createNamedSecrets(memoryVault());
    expect(await resolveSecretRef(secrets, alice, undefined, "user", "tokenRef")).toEqual({
      ok: true,
    });
  });

  it("normalizes the name the agent supplied before looking it up", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "strava_client_secret", "user", "s3cret");
    const res = await resolveSecretRef(
      secrets,
      alice,
      "strava client secret",
      "user",
      "clientSecretRef",
    );
    expect(res).toEqual({ ok: true, value: "s3cret" });
  });

  it("says so precisely when the secret exists at the other scope", async () => {
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "k", "user", "personal");
    const res = await resolveSecretRef(secrets, alice, "k", "org", "clientSecretRef");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("stored at user scope");
    expect(res.ok === false && res.error).toContain('scope "org"');
  });

  it("refuses to fall back to a personal secret for an org connection", async () => {
    // The security point: an org connection must not be silently backed by one
    // member's personally-entered credential.
    const secrets = createNamedSecrets(memoryVault());
    await secrets.set(alice, "k", "user", "personal-value");
    const res = await resolveSecretRef(secrets, alice, "k", "org", "clientSecretRef");
    expect(res).not.toMatchObject({ value: "personal-value" });
  });

  it("points at request_secret when nothing is stored under the name", async () => {
    const secrets = createNamedSecrets(memoryVault());
    const res = await resolveSecretRef(secrets, alice, "missing", "user", "tokenRef");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("request_secret");
  });
});
