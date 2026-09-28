import type { AgentBuilderStore, AgentRecord } from "@intentface/latch-agent-builder";

/**
 * Agent publish history, run against BOTH dialects.
 *
 * The backfill in particular is dialect-specific SQL (`json_object` +
 * `json(col)` on sqlite, `jsonb_build_object` on Postgres) rescuing rows written
 * before versioning existed. It has to produce the same `AgentRecord` on both,
 * or a rollback target silently differs between dev and production.
 */

/** A pre-versioning `latch_agents` row, written straight to the table. */
export interface LegacyAgentRow {
  owner: string;
  name: string;
  title: string;
  modelId: string;
  instructions: string;
  connections: string[];
  exec: Record<string, unknown>;
  /** Column-encoded: NULL=default, 0=unlimited, N=cap. */
  maxSteps: number | null;
  createdAt: number;
}

export interface AgentVersionsEnv<P> {
  store: AgentBuilderStore<P>;
  /** Insert into `latch_agents` bypassing the store, leaving published_version NULL. */
  insertLegacyAgent(row: LegacyAgentRow): Promise<void>;
  /** Re-run this dialect's migration (exercises backfill + its idempotency). */
  remigrate(): Promise<void>;
}

/**
 * Key-order-insensitive JSON, for comparing two spellings of one record. The
 * store compares canonically, so a raw `JSON.stringify` comparison would fail on
 * key order alone (the backfill builds its object in column order) while the
 * store behaved correctly.
 */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

export async function agentVersionsSmoke<P>({
  newEnv,
  p,
  ownerKey,
  assert,
}: {
  /** A fresh, migrated database each call — scenarios must not share state. */
  newEnv: () => Promise<AgentVersionsEnv<P>>;
  p: P;
  /** The owner key `p` maps to at "user" scope, for the legacy-row insert. */
  ownerKey: string;
  assert: (cond: unknown, msg: string) => void;
}): Promise<void> {
  const rec = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({
      name: "helper",
      modelId: "m-1",
      instructions: "help",
      connections: [],
      scope: "user",
      ...over,
    }) as AgentRecord;

  // A two-arg upsert still publishes — the builder agent's path must not regress.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec());
    const vs = await store.listVersions(p, "helper", "user");
    assert(vs.length === 1 && vs[0]!.version === 1, "default upsert appends v1");
    assert(vs[0]!.published, "v1 is marked published");
    assert(vs[0]!.source === "api", "source defaults to api");
    assert((await store.resolve("helper", p))?.instructions === "help", "record is live");
  }

  // Appends on change only.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "v1" }), { author: "u1", source: "editor" });
    await store.upsert(p, rec({ instructions: "v2" }), { author: "u1", source: "editor" });
    assert((await store.listVersions(p, "helper", "user")).length === 2, "changed content appends");

    await store.upsert(p, rec({ instructions: "v2" }), { author: "u1", source: "editor" });
    const vs = await store.listVersions(p, "helper", "user");
    assert(vs.length === 2, "unchanged publish appends nothing");
    assert(vs[0]!.version === 2 && vs[0]!.published, "head is still v2 and live");
    assert(vs[0]!.author === "u1" && vs[0]!.source === "editor", "author/source recorded");

    // Key order and empty arrays are spellings, not changes.
    await store.upsert(p, {
      scope: "user",
      connections: [],
      instructions: "v2",
      modelId: "m-1",
      name: "helper",
      subagents: [],
    } as AgentRecord);
    assert(
      (await store.listVersions(p, "helper", "user")).length === 2,
      "reordered keys / empty arrays are not a change",
    );
  }

  // Rollback moves the pointer; it does NOT append. History stays a list of
  // distinct configurations, so flipping between two of them cannot inflate it.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "one" }));
    await store.upsert(p, rec({ instructions: "two" }));
    await store.upsert(p, rec({ instructions: "three" }));

    await store.activateVersion(p, "helper", "user", 1);

    const vs = await store.listVersions(p, "helper", "user");
    assert(vs.length === 3, "activate appends no version");
    assert(vs.find((v) => v.version === 1)!.published, "v1 is now the live version");
    assert(!vs.find((v) => v.version === 3)!.published, "v3 is no longer live");
    assert(
      (await store.resolve("helper", p))?.instructions === "one",
      "live record carries the activated content",
    );
    assert(
      (await store.getVersion(p, "helper", "user", 3))?.instructions === "three",
      "versions after the activated one survive",
    );

    // Reversible, and still no growth.
    await store.activateVersion(p, "helper", "user", 3);
    assert(
      (await store.listVersions(p, "helper", "user")).length === 3,
      "flipping back and forth never grows history",
    );
    assert(
      (await store.resolve("helper", p))?.instructions === "three",
      "activation is reversible",
    );

    // Activating what is already live is a no-op, not an error.
    await store.activateVersion(p, "helper", "user", 3);
    assert(
      (await store.listVersions(p, "helper", "user")).length === 3,
      "activating the live version changes nothing",
    );

    // Publishing NEW content after a rollback still appends on top.
    await store.activateVersion(p, "helper", "user", 1);
    await store.upsert(p, rec({ instructions: "four" }));
    const after = await store.listVersions(p, "helper", "user");
    assert(after.length === 4 && after[0]!.version === 4, "new content appends after a rollback");
    assert(after[0]!.published, "the new version is live");

    let threw = false;
    try {
      await store.activateVersion(p, "helper", "user", 99);
    } catch {
      threw = true;
    }
    assert(threw, "activating a missing version throws");
  }

  // changedFields + change message: a history list must be readable without
  // fetching two snapshots and diffing them.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "one" }), { source: "editor" });
    const v1 = (await store.listVersions(p, "helper", "user"))[0]!;
    assert(v1.changedFields === undefined, "v1 has nothing to have changed from");
    assert(v1.message === undefined, "no message when none was given");

    await store.upsert(p, rec({ instructions: "two" }), {
      source: "editor",
      message: "  tightened refund wording  ",
    });
    const v2 = (await store.listVersions(p, "helper", "user"))[0]!;
    assert(
      JSON.stringify(v2.changedFields) === JSON.stringify(["instructions"]),
      `only instructions changed (got ${JSON.stringify(v2.changedFields)})`,
    );
    assert(v2.message === "tightened refund wording", "message is trimmed");

    await store.upsert(p, rec({ instructions: "two", modelId: "m-2", subagents: ["helper2"] }), {
      source: "editor",
      message: "   ",
    });
    const v3 = (await store.listVersions(p, "helper", "user"))[0]!;
    assert(
      JSON.stringify(v3.changedFields) === JSON.stringify(["modelId", "subagents"]),
      `multi-field change is listed sorted (got ${JSON.stringify(v3.changedFields)})`,
    );
    assert(v3.message === undefined, "a blank message is stored as absent");

    // changedFields must agree with the rule that decides whether to append at
    // all — an empty-array/absent difference is neither a change nor a field.
    await store.upsert(p, rec({ instructions: "two", modelId: "m-2", subagents: ["helper2"] }));
    assert(
      (await store.listVersions(p, "helper", "user")).length === 3,
      "an unchanged republish still appends nothing",
    );
  }

  // Delete cascades.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "one" }));
    await store.upsert(p, rec({ instructions: "two" }));
    await store.upsert(p, rec({ name: "keeper", instructions: "keep" }));

    await store.remove(p, "user", "helper");
    assert(
      (await store.listVersions(p, "helper", "user")).length === 0,
      "delete cascades to versions",
    );
    assert(!(await store.getVersion(p, "helper", "user", 1)), "no version survives the delete");
    assert(
      (await store.listVersions(p, "keeper", "user")).length === 1,
      "a sibling agent's history is untouched",
    );

    await store.upsert(p, rec({ instructions: "reborn" }));
    const vs = await store.listVersions(p, "helper", "user");
    assert(vs.length === 1 && vs[0]!.version === 1, "recreated agent starts at v1");
  }

  // Concurrent publishes race for max+1; the UNIQUE index arbitrates, losers retry.
  {
    const { store } = await newEnv();
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.upsert(p, rec({ instructions: `concurrent-${i}` }), { author: `u${i}` }),
      ),
    );
    const vs = await store.listVersions(p, "helper", "user");
    const numbers = vs.map((v) => v.version).sort((a, b) => a - b);
    assert(vs.length === n, `all ${n} concurrent publishes appended (got ${vs.length})`);
    assert(
      numbers.every((v, i) => v === i + 1),
      `versions are contiguous 1..${n} (got ${numbers.join(",")})`,
    );
    assert(vs.filter((v) => v.published).length === 1, "exactly one version is live");
  }

  // The migration rescues rows written before versioning existed. Without it the
  // first publish would create v1 from the NEW content and the prompt that was
  // already running would be gone — the failure history exists to prevent.
  {
    const env = await newEnv();
    const { store } = env;
    await env.insertLegacyAgent({
      owner: ownerKey,
      name: "legacy",
      title: "Legacy",
      modelId: "m-legacy",
      instructions: "the prompt that was already running",
      connections: ["github"],
      exec: { sandbox: true },
      maxSteps: 0, // column-encoded "unlimited"
      createdAt: 100,
    });
    assert(
      (await store.listVersions(p, "legacy", "user")).length === 0,
      "a legacy row starts with no history",
    );

    await env.remigrate();

    const vs = await store.listVersions(p, "legacy", "user");
    assert(vs.length === 1 && vs[0]!.version === 1, "backfill creates exactly v1");
    assert(vs[0]!.source === "backfill", "backfill row is labelled");
    assert(vs[0]!.published, "the live row points at the backfilled version");
    assert(vs[0]!.createdAt === 100, "backfill keeps the agent's original timestamp");

    const v1 = (await store.getVersion(p, "legacy", "user", 1))!;
    const live = (await store.getRecord(p, "legacy"))!;
    assert(v1.instructions === "the prompt that was already running", "instructions backfilled");
    assert(v1.modelId === "m-legacy" && v1.title === "Legacy", "scalar columns backfilled");
    assert(v1.connections[0] === "github", "json columns embed as JSON, not as a quoted string");
    assert(v1.exec?.sandbox === true, "nested json backfilled");
    assert(v1.maxSteps === "unlimited", "column-encoded max_steps decodes to its record form");
    assert(v1.subagents === undefined, "NULL columns become absent, not null");
    assert(
      stable(v1) === stable(live),
      `backfilled v1 round-trips to the live record\n  v1:   ${stable(v1)}\n  live: ${stable(live)}`,
    );

    await env.remigrate();
    assert((await store.listVersions(p, "legacy", "user")).length === 1, "backfill is idempotent");
    await store.upsert(p, live, { source: "editor" });
    assert(
      (await store.listVersions(p, "legacy", "user")).length === 1,
      "republishing a backfilled record unchanged appends nothing",
    );

    await store.upsert(p, { ...live, instructions: "edited" }, { source: "editor" });
    const after = await store.listVersions(p, "legacy", "user");
    assert(after.length === 2 && after[0]!.version === 2, "a real edit appends v2");
    assert(
      (await store.getVersion(p, "legacy", "user", 1))?.instructions ===
        "the prompt that was already running",
      "the original prompt is still a rollback target",
    );
  }

  // The publish timeline: versions are the distinct CONFIGURATIONS, activations
  // are what was live when. Activating appends no version, so only the timeline
  // records that a rollback happened at all.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "one" }), { author: "u_a" });
    await store.upsert(p, rec({ instructions: "two" }), { author: "u_b" });
    await store.activateVersion(p, "helper", "user", 1, { actor: "u_c" });
    await store.upsert(p, rec({ instructions: "three" }), { author: "u_a" });

    const log = await store.listActivations(p, "helper", "user");
    assert(log.length === 4, `every publish and activation is recorded (got ${log.length})`);
    assert(log[0]!.version === 3 && log[0]!.source === "publish", "newest first: v3 published");
    assert(log[1]!.version === 1 && log[1]!.source === "activate", "the rollback is recorded");
    assert(log[1]!.actor === "u_c", "who rolled back is recorded");
    assert(log[3]!.version === 1 && log[3]!.source === "publish", "oldest is the first publish");
    assert(
      (await store.listVersions(p, "helper", "user")).length === 3,
      "the timeline is longer than the version list — that is the point",
    );

    assert((await store.listActivations(p, "helper", "user", 2)).length === 2, "limit applies");

    // An unchanged republish publishes nothing, so it activates nothing.
    await store.upsert(p, rec({ instructions: "three" }), { author: "u_a" });
    assert(
      (await store.listActivations(p, "helper", "user")).length === 4,
      "a no-op publish adds no timeline entry",
    );
  }

  // Drafts: per editor, never live, and cascading with the agent.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "published" }));
    assert(!(await store.getDraft(p, "helper", "user")), "no draft to begin with");

    await store.saveDraft(p, "helper", "user", rec({ instructions: "work in progress" }), 1);
    const draft = (await store.getDraft(p, "helper", "user"))!;
    assert(draft.record.instructions === "work in progress", "draft round-trips");
    assert(draft.baseVersion === 1, "base version is kept for the staleness check");
    assert(
      (await store.resolve("helper", p))?.instructions === "published",
      "a draft does NOT affect the running agent",
    );
    assert(
      (await store.listVersions(p, "helper", "user")).length === 1,
      "saving a draft appends no version",
    );

    // Overwrite, then discard.
    await store.saveDraft(p, "helper", "user", rec({ instructions: "second pass" }), 1);
    assert(
      (await store.getDraft(p, "helper", "user"))?.record.instructions === "second pass",
      "saving again replaces the working copy",
    );
    await store.discardDraft(p, "helper", "user");
    assert(!(await store.getDraft(p, "helper", "user")), "discard removes it");

    // listDrafts sees the caller's own and a colleague's, with content withheld.
    await store.saveDraft(p, "helper", "user", rec({ instructions: "mine" }), 1);
    const summaries = await store.listDrafts(p);
    assert(summaries.length === 1, "one draft visible");
    assert(summaries[0]!.name === "helper" && summaries[0]!.mine, "the caller's own draft");
    assert(!("record" in summaries[0]!), "summaries carry no content");

    // Deleting the agent takes drafts and the timeline with it.
    await store.remove(p, "user", "helper");
    assert(!(await store.getDraft(p, "helper", "user")), "delete cascades to drafts");
    assert(
      (await store.listActivations(p, "helper", "user")).length === 0,
      "delete cascades to the timeline",
    );
  }

  // Candidates: named, shared, never live, runnable by ref, and kept when closed.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "published" }));
    const a = await store.saveCandidate(p, "helper", "user", { title: "Shorter", record: rec({ instructions: "short" }), baseVersion: 1 });
    assert(/^c_[a-z0-9]+$/.test(a.id), "a candidate gets a c_ id");
    assert(
      (await store.resolve("helper", p))?.instructions === "published",
      "a candidate does NOT affect the running agent",
    );
    assert(
      (await store.resolve(`helper@${a.id}`, p))?.instructions === "short",
      "name@c_id runs the candidate",
    );
    const b = await store.saveCandidate(p, "helper", "user", { title: "Longer", record: rec({ instructions: "long" }) });
    assert((await store.listCandidates(p, "helper", "user")).length === 2, "several at once");

    // Edit and rename keep the id, the author and the base.
    await store.saveCandidate(p, "helper", "user", { id: a.id, title: "Terse", record: rec({ instructions: "terse" }) });
    const edited = (await store.getCandidate(p, "helper", "user", a.id))!;
    assert(edited.title === "Terse" && edited.record.instructions === "terse", "edit and rename round-trip");
    assert(edited.baseVersion === 1 && edited.createdAt === a.createdAt, "the base and creation survive an edit");

    // Closing hides it from the list, keeps it resolvable, and freezes it.
    await store.closeCandidate(p, "helper", "user", a.id, { publishedAs: 2 });
    const open = await store.listCandidates(p, "helper", "user");
    assert(open.length === 1 && open[0]!.id === b.id, "closed candidates leave the list");
    const all = await store.listCandidates(p, "helper", "user", { closed: true });
    assert(all.find((c) => c.id === a.id)?.publishedAs === 2, "a closed one says what it became");
    assert((await store.resolve(`helper@${a.id}`, p))?.instructions === "terse", "a closed candidate still resolves");
    let refused = false;
    try {
      await store.saveCandidate(p, "helper", "user", { id: a.id, title: "Again", record: rec() });
    } catch {
      refused = true;
    }
    assert(refused, "a closed candidate can't be edited");

    await store.remove(p, "user", "helper");
    assert(!(await store.getCandidate(p, "helper", "user", b.id)), "delete cascades to candidates");
  }

  // `resolve` carries the live version onto the config, which is how a run and
  // its trace end up attributable to an exact configuration.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ instructions: "one" }));
    assert(
      (await store.resolve("helper", p))?.configVersion === 1,
      "resolve carries the published version",
    );

    await store.upsert(p, rec({ instructions: "two" }));
    assert((await store.resolve("helper", p))?.configVersion === 2, "it tracks new publishes");

    // Rollback moves the pointer, so the config must follow it — otherwise a run
    // after a rollback would be filed under a version it did not execute.
    await store.activateVersion(p, "helper", "user", 1);
    const rolledBack = await store.resolve("helper", p);
    assert(rolledBack?.configVersion === 1, "it follows a rollback");
    assert(rolledBack?.instructions === "one", "and matches the content served");
  }

  // The editor's whole lifecycle, in the order a person actually does it. This
  // is the closest thing to clicking through the UI: every step below is the
  // same store call the platform's server functions make.
  {
    const { store } = await newEnv();

    // 1. Create the agent — first publish is v1 and goes live immediately.
    await store.upsert(p, rec({ instructions: "v1 prompt" }), { source: "editor", author: "u1" });
    assert((await store.resolve("helper", p))?.instructions === "v1 prompt", "created and live");

    // 2. Open the editor and type. Autosave writes a draft based on v1.
    await store.saveDraft(p, "helper", "user", rec({ instructions: "work in progress" }), 1);
    assert(
      (await store.resolve("helper", p))?.instructions === "v1 prompt",
      "typing does not touch the running agent",
    );

    // 3. Meanwhile a colleague publishes v2 through the agent builder.
    await store.upsert(p, rec({ instructions: "colleague edit" }), {
      source: "builder-agent",
      author: "u2",
    });

    // 4. Back in the editor, publishing must be recognised as STALE: the draft
    //    is based on v1 but v2 is live. This is the comparison the server fn makes.
    const draft = (await store.getDraft(p, "helper", "user"))!;
    const liveNow = (await store.listVersions(p, "helper", "user")).find((v) => v.published)!;
    assert(draft.baseVersion === 1, "draft remembers what it was based on");
    assert(liveNow.version === 2, "v2 is live");
    assert(draft.baseVersion !== liveNow.version, "stale publish is detectable");
    assert(liveNow.author === "u2", "and we can say who published it");

    // 5. Publish anyway — v3, and the draft is spent.
    await store.upsert(p, draft.record, { source: "editor", author: "u1" });
    await store.discardDraft(p, "helper", "user");
    assert(!(await store.getDraft(p, "helper", "user")), "publishing consumes the draft");
    assert(
      (await store.resolve("helper", p))?.instructions === "work in progress",
      "the published draft is now live",
    );

    // 6. That was wrong — roll back to the colleague's v2. Pointer move only.
    await store.activateVersion(p, "helper", "user", 2, { actor: "u1" });
    assert(
      (await store.resolve("helper", p))?.instructions === "colleague edit",
      "rollback is live immediately",
    );
    const vs = await store.listVersions(p, "helper", "user");
    assert(vs.length === 3, "rollback appended nothing");
    assert(vs.find((v) => v.version === 2)!.published, "v2 is live again");

    // 7. The timeline tells the whole story; the version list does not.
    const log = await store.listActivations(p, "helper", "user");
    assert(log.length === 4, `4 things went live (got ${log.length})`);
    assert(log[0]!.version === 2 && log[0]!.source === "activate", "newest: rolled back to v2");
    assert(log[0]!.actor === "u1", "by whom");
    assert(log[1]!.version === 3 && log[1]!.source === "publish", "before that, v3 was published");
    assert(
      log.filter((a) => a.version === 2).length === 2,
      "v2 went live twice — published once, restored once",
    );
  }

  // History is per (owner, name): personal and org agents never share one.
  {
    const { store } = await newEnv();
    await store.upsert(p, rec({ name: "dual", instructions: "personal", scope: "user" }));
    await store.upsert(p, rec({ name: "dual", instructions: "org", scope: "org" }));

    assert(
      (await store.listVersions(p, "dual", "user")).length === 1 &&
        (await store.listVersions(p, "dual", "org")).length === 1,
      "same name at two scopes keeps two histories",
    );
    assert(
      (await store.getVersion(p, "dual", "user", 1))?.instructions === "personal",
      "personal history holds the personal record",
    );
    assert(
      (await store.getVersion(p, "dual", "org", 1))?.instructions === "org",
      "org history holds the org record",
    );
  }
}
