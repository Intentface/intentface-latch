import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { createKnowledge, fromPGlite, type Knowledge } from "@intentface/latch-knowledge";
import { ORGS, PEOPLE, type Principal } from "./people.js";

/**
 * Who sees what. Members of an org see `/org` as their org's space and `/me`
 * as their own; our staff see the org they're working in and are the only
 * ones who can write practices and playbooks, which is what makes those
 * trusted.
 */
export function knowledgeFor(pg: PGlite): Knowledge<Principal> {
  return createKnowledge<Principal>({
    db: fromPGlite(pg),
    access: (p) => {
      const me = p.staff ? `user:staff/${p.userId}` : `user:${p.orgId}/${p.userId}`;
      return {
        subjects: p.staff ? [me, "group:staff"] : [me, `org:${p.orgId}`],
        mounts: { practices: "practices", org: `org:${p.orgId}`, me },
      };
    },
    trustedSubjects: ["group:staff"],
  });
}

const SEED = fileURLToPath(new URL("../seed/", import.meta.url));

async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

/** Writes everything under `seed/<from>` to `<to>` as the given person. */
async function copy(knowledge: Knowledge<Principal>, as: Principal, from: string, to: string) {
  const view = knowledge.as(as);
  for (const file of await filesIn(join(SEED, from))) {
    await view.write(`${to}/${relative(join(SEED, from), file)}`, await readFile(file, "utf8"));
  }
}

/** Spaces, grants and the example material, on first start. */
export async function seed(pg: PGlite, knowledge: Knowledge<Principal>) {
  await knowledge.migrate();
  // Seeded once, all of it: a start that failed halfway leaves no marker, and the next start begins again.
  await pg.query(`create table if not exists example_seeded (at timestamptz not null default now())`);
  const { rows } = await pg.query<{ n: number }>(`select count(*)::int as n from example_seeded`);
  if (rows[0]!.n > 0) return;
  await pg.query(`truncate kb_versions, kb_grants, kb_files, kb_spaces`);

  const staff = PEOPLE.find((p) => p.principal.staff)!.principal;
  await knowledge.createSpace({ id: "practices", owner: ["advisor"], kind: "shared", name: "Practices" });
  await knowledge.grant({ space: "practices", subject: "everyone", role: "viewer", grantedBy: "seed" });
  await knowledge.grant({ space: "practices", subject: "group:staff", role: "editor", grantedBy: "seed" });
  await copy(knowledge, staff, "practices", "/practices");

  for (const org of ORGS) {
    const space = `org:${org.id}`;
    await knowledge.createSpace({ id: space, owner: [org.id], kind: "org", name: org.name });
    await knowledge.grant({ space, subject: space, role: "viewer", grantedBy: "seed" });
    await knowledge.grant({ space, path: "docs", subject: space, role: "editor", grantedBy: "seed" });
    // Our staff read every customer's space they work in, and only they write its playbooks.
    await knowledge.grant({ space, subject: "group:staff", role: "viewer", grantedBy: "seed" });
    await knowledge.grant({ space, path: "playbooks", subject: "group:staff", role: "editor", grantedBy: "seed" });

    await copy(knowledge, { ...staff, orgId: org.id }, `orgs/${org.id}/playbooks`, "/org/playbooks");
    const member = PEOPLE.find((p) => p.org.id === org.id && !p.principal.staff)!.principal;
    await copy(knowledge, member, `orgs/${org.id}/docs`, "/org/docs");
  }

  for (const person of PEOPLE) {
    const p = person.principal;
    const id = p.staff ? `user:staff/${p.userId}` : `user:${p.orgId}/${p.userId}`;
    await knowledge.createSpace({ id, owner: p.staff ? ["staff", p.userId] : [p.orgId, p.userId], kind: "user" });
    await knowledge.grant({ space: id, subject: id, role: "editor", grantedBy: "seed" });
    await copy(knowledge, p, `people/${person.id}`, "/me");
  }
  await pg.query(`insert into example_seeded default values`);
}
