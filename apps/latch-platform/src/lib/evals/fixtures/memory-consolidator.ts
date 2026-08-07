import type { EvalCase } from "../store";

/**
 * Quality gate for the `memory-consolidator` system agent. Run via the normal
 * evals runner (agentName: "memory-consolidator"): the runner passes no
 * turnContext, so the agent gets NO memory tools and its instructions' dry-run
 * clause engages — it must emit the complete new MEMORY.md in a fenced block,
 * which the deterministic assertions check directly.
 *
 * Seed with `pnpm tsx src/scripts/seed-memory-evals.ts <orgId>` (or paste into
 * the eval UI). The rubric criteria need the pinned judge model configured.
 */

const INDEX = `# Memory — coach · u-demo
updated: 2026-07-01 · entries: 2

## Identity & preferences
- [m-7f3a2c] (2026-06-12, user-said) Prefers concise answers. ← episodes/2026-06-12-09-30-onboarding.md
- [m-a1c2b3] (2026-06-20, tool-derived) Threshold pace ~5:30/km. ← episodes/2026-06-20-14-05-tempo.md

## Archive
`;

const episode = (name: string, facts: string[]) =>
  [
    `--- ${name} ---`,
    "---",
    "chat: cht_demo",
    "agent: coach",
    "extracted_at: 2026-07-27T10:00:00Z",
    "provenance: user-said",
    "---",
    "## Facts",
    ...facts.map((f) => `- (user-said) ${f}`),
  ].join("\n");

// Mirrors buildConsolidationPrompt's block order (policy → schema → episodes →
// expiry) so the dry-run task looks like a real sweep task.
const task = (args: {
  episodes?: string[];
  expire?: string[];
  index?: string;
  schema?: string;
  policy?: string;
}) =>
  [
    "You are consolidating this agent's memory of this user. Today is 2026-07-27.",
    "",
    ...(args.policy ? [`POLICY (non-negotiable floor): ${args.policy}`, ""] : []),
    ...(args.schema
      ? [
          'INDEX SCHEMA — the required top-level sections ("## Archive" is always allowed last):',
          args.schema,
          "",
        ]
      : []),
    "Current MEMORY.md:",
    "```markdown",
    args.index ?? INDEX,
    "```",
    "",
    "New episodes to fold in:",
    ...(args.episodes?.length ? args.episodes : ["(none)"]),
    "",
    "Expiry candidates (move to Archive unless a new episode revives them):",
    ...(args.expire?.length ? args.expire.map((e) => `- ${e}`) : ["(none)"]),
  ].join("\n");

export const MEMORY_CONSOLIDATOR_EVAL_CASES: EvalCase[] = [
  {
    id: "merge-new-fact",
    name: "adds a new fact without dropping existing entries",
    input: task({
      episodes: [
        episode("episodes/2026-07-27-10-00-schedule.md", [
          "Prefers morning runs before work",
        ]),
      ],
    }),
    expected: {
      assertions: {
        // Both prior entries survive (no silent deletion) + the new fact lands.
        contains: ["[m-7f3a2c]", "[m-a1c2b3]", "morning runs"],
        regex: ["- \\[m-[0-9a-z]{4,8}\\] \\(2026-07-27, user-said\\)[^\\n]*morning runs"],
      },
    },
  },
  {
    id: "supersede-contradiction",
    name: "a contradicted fact moves to Archive with a superseded marker",
    input: task({
      episodes: [
        episode("episodes/2026-07-27-11-00-test.md", [
          "New threshold test: pace is now ~5:10/km",
        ]),
      ],
    }),
    expected: {
      assertions: {
        contains: ["[m-a1c2b3]", "5:10"],
        regex: ["\\[m-a1c2b3\\][^\\n]*superseded 2026-07-27"],
      },
      rubric: [
        "The old threshold-pace entry (m-a1c2b3) appears under the '## Archive' heading, not in an active section.",
      ],
    },
  },
  {
    id: "expire-unrecalled",
    name: "expiry candidates move to Archive",
    input: task({
      episodes: [
        episode("episodes/2026-07-27-12-00-note.md", ["Signed up for the October marathon"]),
      ],
      expire: ["m-7f3a2c (never recalled)"],
    }),
    expected: {
      assertions: {
        contains: ["[m-7f3a2c]", "marathon"],
        regex: ["\\[m-7f3a2c\\][^\\n]*superseded"],
      },
    },
  },
  {
    id: "no-changes",
    name: "nothing new → says so instead of rewriting",
    input: task({
      episodes: [
        episode("episodes/2026-07-27-13-00-dup.md", [
          "Prefers concise answers", // already entry m-7f3a2c verbatim
        ]),
      ],
    }),
    expected: {
      assertions: { contains: ["no changes"] },
    },
  },
  {
    id: "schema-driven-sections",
    name: "a schema'd task files entries under the schema's sections, inventing none",
    input: task({
      index: "# Memory — interviewer · u-demo\nupdated: 2026-07-01 · entries: 0\n\n## Archive\n",
      schema: [
        "## What was gone through",
        "- Topics covered with this person",
        "## Where fatigued",
        "- Where their attention dropped",
      ].join("\n"),
      policy:
        "Private per-user memory: personal detail relevant to this agent is allowed. " +
        "NEVER store credentials, secrets, tokens, one-time codes, or full account/ID numbers.",
      episodes: [
        episode("episodes/2026-07-27-15-00-interview.md", [
          "Covered system design and incident response",
          "Attention dropped noticeably during the systems-design deep dive",
        ]),
      ],
    }),
    expected: {
      assertions: {
        contains: ["## What was gone through", "## Where fatigued", "system design"],
      },
      rubric: [
        "Every non-Archive '##' section heading in the produced MEMORY.md comes from the task's INDEX SCHEMA ('What was gone through', 'Where fatigued') — no invented top-level sections.",
        "The fatigue observation is filed under '## Where fatigued', and the covered topics under '## What was gone through'.",
      ],
    },
  },
  {
    id: "no-invented-certainty",
    name: "hedged facts stay hedged (no manufactured confidence)",
    input: task({
      episodes: [
        episode("episodes/2026-07-27-14-00-hedge.md", [
          "Thinks they might have a mild calf strain, not confirmed",
        ]),
      ],
    }),
    expected: {
      assertions: { contains: ["calf"] },
      rubric: [
        "The calf-strain entry preserves the uncertainty (e.g. 'might', 'suspected', 'unconfirmed') — it is NOT stated as a confirmed injury.",
      ],
    },
  },
];
