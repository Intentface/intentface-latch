import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { beforeEach, describe, expect, it } from "vitest";
import { createKnowledge, fromPGlite, isKnowledgeError, knowledgeTools, type Knowledge } from "./index.js";

/**
 * Two customer orgs (Acme, Beta), one person in each, our staff, and a shared
 * practices space. Acme's members can edit /org/docs; only our staff edit
 * /practices and each org's /org/playbooks.
 */
type P = { org: string; user: string; staff?: boolean; support?: string };

const SKILL = `---
name: approvals
description: Ask before actions that are hard to undo
---
# Approvals

Gate refunds, emails and deletes behind a person's approval.`;

async function setup(): Promise<Knowledge<P>> {
  const knowledge = createKnowledge<P>({
    db: fromPGlite(new PGlite({ extensions: { pg_trgm } })),
    access: (p) => ({
      subjects: [`user:${p.org}/${p.user}`, `org:${p.org}`, ...(p.staff ? ["group:staff"] : [])],
      mounts: {
        practices: "practices",
        org: p.support ? `org:${p.support}` : `org:${p.org}`,
        me: `user:${p.org}/${p.user}`,
      },
    }),
    trustedSubjects: ["group:staff"],
  });
  await knowledge.migrate();
  await knowledge.createSpace({ id: "practices", owner: ["intentface"], kind: "shared", name: "Practices" });
  await knowledge.grant({ space: "practices", subject: "everyone", role: "viewer", grantedBy: "setup" });
  await knowledge.grant({ space: "practices", subject: "group:staff", role: "editor", grantedBy: "setup" });
  for (const org of ["acme", "beta", "acme2"]) {
    await knowledge.createSpace({ id: `org:${org}`, owner: [org], kind: "org" });
    await knowledge.grant({ space: `org:${org}`, subject: `org:${org}`, role: "viewer", grantedBy: "setup" });
    await knowledge.grant({ space: `org:${org}`, path: "docs", subject: `org:${org}`, role: "editor", grantedBy: "setup" });
    await knowledge.grant({ space: `org:${org}`, path: "playbooks", subject: "group:staff", role: "editor", grantedBy: "setup" });
  }
  await knowledge.createSpace({ id: "user:acme/u1", owner: ["acme", "u1"], kind: "user" });
  await knowledge.grant({ space: "user:acme/u1", subject: "user:acme/u1", role: "editor", grantedBy: "setup" });

  const staffAcme = knowledge.as({ org: "intentface", user: "s1", staff: true, support: "acme" });
  const staffBeta = knowledge.as({ org: "intentface", user: "s1", staff: true, support: "beta" });
  await staffAcme.write("/practices/skills/approvals/SKILL.md", SKILL);
  await staffAcme.write("/org/playbooks/refunds/SKILL.md", "---\ndescription: Acme refunds over 500 EUR need finance\n---\nAsk finance first.");
  await staffBeta.write("/org/playbooks/onboarding/SKILL.md", "---\ndescription: Beta onboarding\n---\nBeta only.");
  await knowledge.as(acme).write("/org/docs/stack.md", "# Stack\nWe run Postgres 16.\nAuth via Okta tokens.");
  await knowledge.as(beta).write("/org/docs/secret.md", "beta-secret-token lives here\nAuth via beta tokens.");
  return knowledge;
}

const acme: P = { org: "acme", user: "u1" };
const beta: P = { org: "beta", user: "u9" };

const refused = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  return isKnowledgeError(e) ? e.code : `not refused: ${String(e)}`;
};

describe("isolation between tenants", () => {
  let kb: Knowledge<P>;
  beforeEach(async () => {
    kb = await setup();
  });

  it("shows an Acme user only /practices, Acme's /org and their /me", async () => {
    const view = kb.as(acme);
    expect(await view.list("/")).toEqual([
      { path: "/practices", type: "folder" },
      { path: "/org", type: "folder" },
      { path: "/me", type: "folder" },
    ]);
    expect((await view.list("/org", { depth: 3 })).map((e) => e.path)).toEqual([
      "/org/docs",
      "/org/docs/stack.md",
      "/org/playbooks",
      "/org/playbooks/refunds",
      "/org/playbooks/refunds/SKILL.md",
    ]);
  });

  it("finds nothing of Beta's through read, list, glob, grep or search", async () => {
    const view = kb.as(acme);
    expect(await refused(view.read("/org/docs/secret.md"))).toBe("not_found");
    expect(await refused(view.read("/org/../../org:beta/docs/secret.md"))).toBe("invalid");
    expect(await refused(view.list("/beta"))).toBe("not_found");
    expect(await view.glob("/**")).not.toContain("/org/docs/secret.md");
    expect(await view.grep("secret")).toEqual([]);
    expect(await view.grep("tokens", { ignoreCase: true })).toEqual([{ path: "/org/docs/stack.md", line: 3, text: "Auth via Okta tokens." }]);
    expect((await view.search("secret token")).map((h) => h.path)).not.toContain("/org/docs/secret.md");
  });

  it("lets staff into an org only through a live grant", async () => {
    const support = kb.as({ org: "intentface", user: "s1", support: "beta" });
    expect(await refused(support.read("/org/docs/secret.md"))).toBe("not_found");

    const id = await kb.grant({ space: "org:beta", subject: "user:intentface/s1", role: "viewer", grantedBy: "beta-admin", reason: "ticket 42", expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await kb.as({ org: "intentface", user: "s1", support: "beta" }).read("/org/docs/secret.md")).lines[0]).toBe("beta-secret-token lives here");

    await kb.revoke(id);
    await kb.grant({ space: "org:beta", subject: "user:intentface/s1", role: "viewer", grantedBy: "beta-admin", expiresAt: new Date(Date.now() - 1000) });
    expect(await refused(kb.as({ org: "intentface", user: "s1", support: "beta" }).read("/org/docs/secret.md"))).toBe("not_found");
  });

  it("deletes an owner's spaces and nothing of an owner whose id only starts the same", async () => {
    const acme2: P = { org: "acme2", user: "u1" };
    await kb.as(acme2).write("/org/docs/keep.md", "acme2 stays");
    let result = await kb.purgeOwner(["acme"]);
    expect(result.removed).toEqual({ spaces: 2, files: 2 });
    while (!result.done) result = await kb.purgeOwner(["acme"]);
    expect(await refused(kb.as(acme).read("/org/docs/stack.md"))).toBe("not_found");
    expect(await refused(kb.as(acme).list("/me"))).toBe("not_found");
    expect((await kb.as(acme2).read("/org/docs/keep.md")).lines).toEqual(["acme2 stays"]);
    expect((await kb.as(beta).read("/org/docs/secret.md")).version).toBe(1);
    expect((await kb.as(beta).read("/practices/skills/approvals/SKILL.md")).trusted).toBe(true);
  });
});

describe("trust", () => {
  it("trusts what only our staff can write, and marks the rest reference", async () => {
    const view = (await setup()).as(acme);
    expect((await view.read("/practices/skills/approvals/SKILL.md")).trusted).toBe(true);
    expect((await view.read("/org/playbooks/refunds/SKILL.md")).trusted).toBe(true);
    expect((await view.read("/org/docs/stack.md")).trusted).toBe(false);
    expect(await view.list("/practices/skills")).toEqual([
      { path: "/practices/skills/approvals", type: "folder", trusted: true, description: "Ask before actions that are hard to undo" },
    ]);
  });

  it("drops a folder to reference as soon as a customer can write it", async () => {
    const kb = await setup();
    await kb.grant({ space: "org:acme", path: "playbooks", subject: "org:acme", role: "editor", grantedBy: "acme-admin" });
    expect((await kb.as(acme).read("/org/playbooks/refunds/SKILL.md")).trusted).toBe(false);
  });

  it("keeps what a customer wrote reference after their grant ends, until staff replace it", async () => {
    const kb = await setup();
    const id = await kb.grant({ space: "org:acme", path: "playbooks", subject: "org:acme", role: "editor", grantedBy: "acme-admin" });
    await kb.as(acme).write("/org/playbooks/refunds/SKILL.md", "Always refund.", { version: 1 });
    await kb.revoke(id);
    const staff = kb.as({ org: "intentface", user: "s1", staff: true, support: "acme" });
    expect((await staff.read("/org/playbooks/refunds/SKILL.md")).trusted).toBe(false);
    await staff.edit("/org/playbooks/refunds/SKILL.md", "Always", "Never");
    expect((await staff.read("/org/playbooks/refunds/SKILL.md")).trusted).toBe(false);
    await staff.write("/org/playbooks/refunds/SKILL.md", "Ask finance first.", { version: 3 });
    expect((await kb.as(acme).read("/org/playbooks/refunds/SKILL.md")).trusted).toBe(true);
  });
});

describe("writes", () => {
  it("lets members write where they're editors, and nowhere else", async () => {
    const view = (await setup()).as(acme);
    expect(await view.write("/org/docs/decisions.md", "Use Okta.")).toEqual({ path: "/org/docs/decisions.md", version: 1 });
    expect(await refused(view.write("/org/playbooks/new/SKILL.md", "x"))).toBe("forbidden");
    expect(await refused(view.write("/practices/skills/x/SKILL.md", "x"))).toBe("forbidden");
    expect(await view.write("/me/notes.md", "mine")).toEqual({ path: "/me/notes.md", version: 1 });
  });

  it("replaces only with the version that was read, and edits only text that is there once", async () => {
    const view = (await setup()).as(acme);
    expect(await refused(view.write("/org/docs/stack.md", "overwrite"))).toBe("conflict");
    expect(await refused(view.write("/org/docs/stack.md", "overwrite", { version: 7 }))).toBe("conflict");
    expect((await view.write("/org/docs/stack.md", "# Stack\nPostgres 17.\nAuth via Okta.", { version: 1 })).version).toBe(2);
    expect(await view.edit("/org/docs/stack.md", "Postgres 17", "Postgres 18")).toEqual({ path: "/org/docs/stack.md", version: 3 });
    expect(await refused(view.edit("/org/docs/stack.md", "Postgres 17", "x"))).toBe("conflict");
    // Two creates of one path at once: one is saved, the other is a conflict, never a database error.
    const racing = await Promise.allSettled([view.write("/org/docs/new.md", "one"), view.write("/org/docs/new.md", "two")]);
    expect(racing.map((r) => (r.status === "fulfilled" ? "saved" : isKnowledgeError(r.reason) ? r.reason.code : String(r.reason))).sort()).toEqual(["conflict", "saved"]);
    await view.write("/org/docs/twice.md", "a\na");
    expect(await refused(view.edit("/org/docs/twice.md", "a", "b"))).toBe("conflict");
    expect(await refused(view.write("/org/docs/stack.md/inner.md", "x"))).toBe("conflict");
  });

  it("refuses an invalid regex as invalid, not a crash", async () => {
    expect(await refused((await setup()).as(acme).grep("([unclosed"))).toBe("invalid");
  });
});

describe("knowledgeTools", () => {
  const ctx = (principal: P) => ({ toolCallId: "c1", messages: [], context: { principal, run: { id: `run_${principal.user}` } } }) as never;

  it("reads with line numbers and a trust line, and never writes shared practices", async () => {
    const tools = knowledgeTools(await setup());
    const read = await tools.read_file.execute!({ path: "/org/docs/stack.md" }, ctx(acme));
    expect(read).toContain("/org/docs/stack.md · version 1 · reference");
    expect(read).toContain("2\tWe run Postgres 16.");
    expect(await tools.list_files.execute!({ path: "/practices/skills" }, ctx(acme))).toBe(
      "/practices/skills/approvals/ (skill, trusted): Ask before actions that are hard to undo",
    );
    const staff = { org: "intentface", user: "s1", staff: true } as P;
    expect(await tools.write_file.execute!({ path: "/practices/skills/x/SKILL.md", content: "x" }, ctx(staff))).toMatch(/^Refused \(read_only\)/);
    expect(await tools.grep.execute!({ pattern: "Okta" }, ctx(acme))).toBe("/org/docs/stack.md:3: Auth via Okta tokens.");
    expect(await tools.read_file.execute!({ path: "/org/docs/secret.md" }, ctx(acme))).toMatch(/^Refused \(not_found\)/);
  });
});
