import type { StorageAdapter } from "@intentface/latch-core";

/**
 * Schedule persistence, run against BOTH dialects.
 *
 * `delivery` is the host's opaque channel target: `jsonb` on Postgres,
 * json-in-text on sqlite. It has to survive create → list → claim identically
 * on both, or a scheduled push works in dev and silently stops delivering in
 * production. `bumpSchedule` ("run now") is owner-fenced and enabled-only.
 */
export async function scheduleSmoke<P>({
  store,
  me,
  other,
  assert,
}: {
  store: StorageAdapter<P>;
  me: P;
  other: P;
  assert: (cond: boolean, msg: string) => void;
}): Promise<void> {
  const delivery = { kind: "telegram", botId: "bot-1", nested: { epoch: 2 } };
  const soon = Date.now() + 60 * 60 * 1000;

  const created = await store.createSchedule(me, {
    agent: "briefer",
    cron: "0 8 * * 1-5",
    timezone: "Europe/Helsinki",
    prompt: "morning brief",
    nextRunAt: soon,
    delivery,
  });
  assert(
    JSON.stringify(created.delivery) === JSON.stringify(delivery),
    "schedule returns the delivery blob it was created with",
  );

  const listed = await store.listSchedules(me);
  assert(
    JSON.stringify(listed[0]?.delivery) === JSON.stringify(delivery),
    "delivery survives a list round trip",
  );
  assert((await store.listSchedules(other)).length === 0, "schedules are owner-isolated");

  // A schedule with no target stays undefined rather than becoming null/{}.
  const plain = await store.createSchedule(me, {
    agent: "briefer",
    cron: null,
    prompt: "no delivery",
    nextRunAt: soon,
  });
  assert(plain.delivery === undefined, "absent delivery reads back as undefined");

  // Not due yet.
  assert(
    (await store.claimDueSchedules(Date.now(), 30_000, "node-1")).length === 0,
    "a future schedule isn't claimed",
  );

  // Another owner can't arm it, and is told so rather than getting a silent no-op.
  assert(
    (await store.bumpSchedule(other, created.id)) === false,
    "bumpSchedule reports false for another owner",
  );
  assert(
    (await store.claimDueSchedules(Date.now(), 30_000, "node-1")).length === 0,
    "bumpSchedule is owner-fenced",
  );
  assert(
    (await store.bumpSchedule(me, "sch_does_not_exist")) === false,
    "bumpSchedule reports false for an unknown id",
  );

  assert((await store.bumpSchedule(me, created.id)) === true, "bumpSchedule reports the arm");
  const claimed = await store.claimDueSchedules(Date.now(), 30_000, "node-1");
  assert(
    claimed.some((s) => s.id === created.id),
    "bumpSchedule makes it due on the next tick",
  );
  const claimedOne = claimed.find((s) => s.id === created.id)!;
  assert(
    JSON.stringify(claimedOne.delivery) === JSON.stringify(delivery),
    "delivery survives the claim the cron reads it through",
  );
  assert(
    JSON.stringify(claimedOne.identity) === JSON.stringify(me),
    "claim carries the identity blob (to rebuild the principal)",
  );

  // Spend it, then confirm a finished schedule can't be re-armed.
  await store.completeSchedule(
    created.id,
    { nextRunAt: Date.now(), lastRunAt: Date.now(), enabled: false },
    "node-1",
  );
  assert(
    (await store.bumpSchedule(me, created.id)) === false,
    "bumpSchedule reports false for a spent one-shot",
  );
  assert(
    !(await store.claimDueSchedules(Date.now(), 30_000, "node-2")).some(
      (s) => s.id === created.id,
    ),
    "a disabled schedule can't be resurrected by bumping",
  );

  await store.deleteSchedule(me, created.id);
  await store.deleteSchedule(me, plain.id);
  assert((await store.listSchedules(me)).length === 0, "schedules delete cleanly");
}
