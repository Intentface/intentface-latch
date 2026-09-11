import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { composeInstructions, parseSegments, VARIANTS, type Variant } from "./compose";
import { agentNameFor, approvalFor, ARMS, buildAllVariants, buildVariant, CARD_ARMS, COMPOSE_AS, CONNECTIONS_FOR, WRITE_TOOLS } from "../variants";

/**
 * Plan verification 2 + 4: the variant boundary is real at the instruction layer
 * (composition invariant), at the connection layer (tool surface), and D is the
 * production prompt modulo the three recorded pre-freeze edits (snapshot).
 */

const segments = parseSegments();
const composed = Object.fromEntries(VARIANTS.map((v) => [v, composeInstructions(v, segments)])) as Record<
  Variant,
  string
>;

/** Strings a variant must NEVER contain — it lacks the plane they belong to. */
const FORBIDDEN: Record<Variant, RegExp[]> = {
  A: [
    /edge-client/,
    /edge-v2-kn/,
    /edge-v2-inbox/,
    /edge-kn/,
    /edge-inbox/,
    /\bTier[- ]?[1234]\b/i,
    /\btiers?\b/i,
    /\bplacement\b/i,
    /\bpillar/i,
    /agent-infra|\bax\b|agentic-coding-practises|\binsights\b/,
    /\bgap[- ]?(note|file|inbox|path|logging)|\blog (it|the|a|any|that)( \w+)? (as a )?gap|knowledge[- ]gap|honest gap|unlogged gap|convert it to a gap|as a gap\b/i,
    /orient|read_file|edit_file/,
    /\bworkspace/i,
    /playbook|catalog/i,
  ],
  B: [/edge-v2-kn/, /edge-kn/, /edge-v2-inbox/, /edge-inbox/, /\bTier[- ]?1\b/, /\bpillar/i, /agent-infra|agentic-coding-practises|\binsights\b/, /\bgap[- ]?(note|file|inbox|path|logging)|\blog (it|the|a|any|that)( \w+)? (as a )?gap|knowledge[- ]gap|honest gap|unlogged gap|convert it to a gap|as a gap\b/i, /playbook|catalog/i],
  C: [/edge-client/, /edge-v2-inbox/, /edge-inbox/, /\bTier[- ]?[23]\b/, /\bplacement\b/i, /\bmemory note/i, /\bgap[- ]?(note|file|inbox|path|logging)|\blog (it|the|a|any|that)( \w+)? (as a )?gap|knowledge[- ]gap|honest gap|unlogged gap|convert it to a gap|as a gap\b/i, /\bctx\b/],
  D: [],
};

describe("edge-v2 prompt — composition invariant", () => {
  it("parses into tagged segments with no orphan text", () => {
    expect(segments.length).toBeGreaterThan(50);
    for (const s of segments) expect(s.variants.size, `segment at line ${s.line}`).toBeGreaterThan(0);
  });

  for (const v of VARIANTS) {
    it(`variant ${v} never references a plane it lacks`, () => {
      const text = composed[v];
      for (const re of FORBIDDEN[v]) {
        const m = re.exec(text);
        expect(m, `variant ${v} matched ${re} at …${text.slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 60)}…`).toBeNull();
      }
    });
  }

  it("every variant keeps the shared craft and drops the get_current_date lines (E1)", () => {
    for (const v of VARIANTS) {
      expect(composed[v]).toContain("# First response in any new conversation — keep it short");
      expect(composed[v]).toContain("## 1. Read the stage");
      expect(composed[v]).toContain("# Safety — overrides everything");
      expect(composed[v]).not.toContain("get_current_date");
    }
  });

  it("renumbers the procedure steps consecutively per variant (D keeps 1–8)", () => {
    const steps = (t: string) => [...t.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    for (const v of VARIANTS) {
      const got = steps(composed[v]);
      expect(got, `variant ${v}`).toEqual(got.map((_, i) => i + 1));
    }
    expect(steps(composed.D)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(steps(composed.A)).toEqual([1, 2, 3, 4]);
  });

  it("B and D carry the memory-write deliverable; A and C do not", () => {
    for (const v of ["B", "D"] as const) expect(composed[v]).toContain("# Every question has TWO deliverables, not one");
    for (const v of ["A", "C"] as const) expect(composed[v]).not.toContain("TWO deliverables");
  });

  it("C and D carry the approved pillar set; D alone carries the inbox and the precedence ladder", () => {
    for (const v of ["C", "D"] as const) {
      expect(composed[v]).toContain("# Currently approved official playbook pillars");
      expect(composed[v]).toContain("`ai-system-design`");
    }
    expect(composed.D).toContain("# Precedence depends on the question");
    expect(composed.D).toContain("# Tier-1 / Tier-2 collisions");
    expect(composed.D).toContain("edge-v2-inbox_create");
    expect(composed.D).toContain("edge-inbox/inbox-twentyone");
    // E2: the write-only inbox scope has no orient/read_file — D must not ask for them.
    expect(composed.D).not.toMatch(/edge-v2-inbox_(orient|read_file|edit_file)/);
  });
});

describe("edge-v2 prompt — D equals the captured production text modulo E1–E3", () => {
  const captured = readFileSync(new URL("../v0/edge-v2-instructions.md", import.meta.url), "utf8");
  const paragraphs = (t: string) =>
    t
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

  /** Captured paragraphs deliberately absent from D. Anything else missing is a regression. */
  const REMOVED_FROM_D = [
    // E1 — phantom tool
    "Before writing any dated file — memory notes, gap notes, insights shelf-life checks —\ncall `get_current_date` for today's date. Never assume or guess it.",
    // E2 — inbox rewrite: discovery-by-orient / edit-the-existing-gaps-file clauses
    "- knowledge reads → `edge-v2-kn_orient`, `edge-v2-kn_read_file`;\n- inbox discovery and gap writes → `edge-v2-inbox_orient`,\n  `edge-v2-inbox_read_file`, `edge-v2-inbox_edit_file`.",
    "Its client-scoped folder lives somewhere beneath:",
    "`edge-inbox/`",
    "The client-scoped folder name is DYNAMIC.",
    "Do NOT hardcode it.",
    "For example, the current workspace may expose a structure like:",
    "`edge-inbox/<client-inbox-folder>/gaps`",
    "but the exact folder name and gap file MUST be discovered through\n`edge-v2-inbox_orient` THIS TURN.",
    "Never reconstruct the inbox folder from:",
    "- client name;\n- account name;\n- prior conversation;\n- remembered folder name;\n- naming convention;\n- numbering convention.",
    "Use the exact folder/file IDs returned by `edge-v2-inbox_orient`.",
    "Because both connections see the same workspace, an orient through one may surface\nfolders belonging to the other area. That is a visibility artefact, not permission.",
    "# Current observed inbox shape",
    "The current environment may expose a client-scoped folder beneath `edge-inbox/`,\ncontaining an existing `gaps` file.",
    "That observed shape is informative only.",
    "The runtime `edge-v2-inbox_orient` result remains authoritative every turn.",
    "Do not hardcode a specific client inbox folder name into behaviour.",
    "- edit an EXISTING gap file discovered through `edge-v2-inbox_orient`;\n- append gap notes to it.",
    "- create files;\n- create folders;\n- rename anything;\n- move anything;\n- delete anything;\n- guess an inbox folder;\n- guess a gap-file path;\n- guess a file ID.",
    "1. call `edge-client_orient`;\n2. call `edge-v2-kn_orient`;\n3. call `edge-v2-inbox_orient`.",
    "# From `edge-v2-inbox_orient`",
    "Identify:\n\n- the exact client-scoped inbox folder beneath `edge-inbox/`;\n- the exact existing writable gap file inside that folder.",
    "- the exact client-scoped inbox folder beneath `edge-inbox/`;\n- the exact existing writable gap file inside that folder.",
    "Use file IDs exactly as returned by orient.",
    "Never synthesize a path because you know the workspace hierarchy.",
    "If orient shows something, that result is authoritative for THIS turn.",
    "If orient does not show it, do not assume it exists.",
    "use `edge-v2-inbox_edit_file` on the EXISTING `gaps` file inside the\nclient-scoped folder beneath `edge-inbox/`.",
    "The exact file ID MUST come from `edge-v2-inbox_orient` THIS TURN.",
    "APPEND a short, dated gap note.",
    "Only EDIT existing files.",
    "Never create new ones.",
    "Write ONLY to the EXISTING gap file inside the client-scoped folder beneath\n`edge-inbox/`, as discovered by `edge-v2-inbox_orient`.",
    "Whenever official knowledge could not answer well, append a gap.",
    "- READ approved and relevant material beneath `edge-kn/`, through `edge-v2-kn`.\n- READ relevant existing material beneath `edge-inbox/`, through `edge-v2-inbox`.\n- EDIT the EXISTING gap file within the correct client-scoped inbox folder, through\n  `edge-v2-inbox`.",
    "- any write anywhere beneath `edge-kn/`;\n- any write through `edge-v2-kn`;\n- creating a file anywhere in the shared IF workspace;\n- creating a folder anywhere in the shared IF workspace;\n- renaming anything;\n- moving anything;\n- deleting anything;\n- replacing shared knowledge;\n- guessing an inbox folder;\n- constructing an inbox folder from client identity;\n- guessing a gap-file path;\n- guessing a file ID.",
    "Only append to the exact existing gap file whose ID came from\n`edge-v2-inbox_orient` THIS TURN.",
    // E3 — list items that were split across blocks re-join as different paragraphs
    "- a playbook generalisation;\n- a memory note;\n- external knowledge.",
    "- official house guidance;\n- their own facts;\n- prior engagement memory;\n- external material.",
    "If a Tier-4 fact conflicts with tiers 1-3:",
    "- official knowledge;\n- playbook pillars;\n- examples;\n- assessment files;\n- source files;\n- client context;\n- memory;\n- inbox folders;\n- gap files.",
    "- filenames;\n- paths;\n- folder names;\n- pillar names;\n- workspace names;\n- connection names;\n- file IDs;\n- tool names.",
    "- `edge-v2-kn`\n- `edge-v2-inbox`\n- `edge-client`\n- `edge-kn`\n- `edge-inbox`\n- `.md`\n- `playbook`\n- `catalog`\n- `ctx`\n- tool names\n- `(see …)`",
    "- official Tier-1 knowledge;\n- client context;\n- client memory;",
    "- use the external information carefully;\n- explicitly mark it as external;\n- log the official silence as a gap.",
    "- the recommendation may stand on official playbook guidance alone;\n- log the missing peer example as a gap.",
    "Does every specific company, product, tool, metric, outcome, benchmark, or case trace to\na valid tier?\n\nIf not:\nremove it or convert it to a gap.",
    "- workspace names;\n- folder names;\n- filenames;\n- paths;\n- pillar names;\n- tool names;\n- file IDs;\n- `.md`;\n- \"playbook\";\n- \"catalog\";\n- \"(see …)\"?",
    "- facts;\n- companies;\n- metrics;\n- examples;\n- filenames;\n- paths;\n- folders;\n- workspace structure;\n- file IDs;\n- tool results;\n- official playbook status.",
    "- say so;\n- use Tier 4 only if appropriate;\n- log the gap when required.",
    "A stance with no rung tag, or a loose rung tag, may still apply broadly.\n\nJudge it against this client's placement.\n\nDo not invent a rung tag.",
  ];

  it("keeps every captured paragraph except the enumerated E1–E3 removals", () => {
    const d = composed.D;
    const dNorm = d.replace(/\s+/g, " ");
    const missing = paragraphs(captured).filter((p) => !dNorm.includes(p.replace(/\s+/g, " ")));
    const unexpected = missing.filter((p) => !REMOVED_FROM_D.some((r) => r.replace(/\s+/g, " ") === p.replace(/\s+/g, " ")));
    expect(unexpected, `captured paragraphs missing from D:\n\n${unexpected.join("\n\n---\n\n")}`).toEqual([]);
  });

  it("adds nothing to D beyond the enumerated E2/E3 replacements", () => {
    const capturedNorm = captured.replace(/\s+/g, " ");
    const ALLOWED_NEW = [
      /edge-v2-inbox_create|inbox-twentyone|WRITE-ONLY|write into it blind|dated gap-note|different inbox folder|editing an existing inbox file|other than the inbox folder above|This client's inbox folder is:|^Name it `YYYY-MM-DD_<short-slug>\.md`|could not answer well, log a gap\./,
      /In the client workspace, only EDIT existing files\.|Never create new ones there\./,
      /^- gap writes → `edge-v2-inbox_create`\.$/,
      /^1\. call `edge-client_orient`;\n2\. call `edge-v2-kn_orient`\.$/,
    ];
    const added = paragraphs(composed.D)
      .filter((p) => !capturedNorm.includes(p.replace(/\s+/g, " ")))
      .filter((p) => !ALLOWED_NEW.some((re) => re.test(p)));
    expect(added, `paragraphs in D absent from the captured text:\n\n${added.join("\n\n---\n\n")}`).toEqual([]);
  });
});

describe("edge-v2 variants — tool surface (plan verification 2)", () => {
  const variants = buildAllVariants();

  it("A has no connections; B/C one each; D all three", () => {
    expect(CONNECTIONS_FOR.A).toEqual([]);
    expect(CONNECTIONS_FOR.B).toEqual(["edge-client"]);
    expect(CONNECTIONS_FOR.C).toEqual(["edge-v2-kn"]);
    expect(CONNECTIONS_FOR.D).toEqual(["edge-client", "edge-v2-kn", "edge-v2-inbox"]);
    for (const v of variants) expect(v.record.connections).toEqual([...CONNECTIONS_FOR[v.variant]]);
  });

  it("every write tool of every present writable connection is approval-gated (inert under blockGated)", () => {
    for (const v of ["B", "D"] as const) {
      const approval = approvalFor(v);
      for (const conn of CONNECTIONS_FOR[v].filter((c) => c !== "edge-v2-kn")) {
        for (const tool of WRITE_TOOLS) expect(approval[`${conn}_${tool}`], `${v}: ${conn}_${tool}`).toBe(true);
      }
      // reads stay ungated
      for (const conn of CONNECTIONS_FOR[v].filter((c) => c !== "edge-v2-inbox")) {
        expect(approval[`${conn}_orient`], `${v}: ${conn}_orient`).toBe(false);
      }
    }
    // the knowledge scope exposes no write tools at all — nothing to gate, and never gate reads
    expect(Object.keys(approvalFor("C")).filter((t) => WRITE_TOOLS.some((w) => t.endsWith(`_${w}`)))).toEqual([]);
    expect(approvalFor("A")).toEqual({});
  });

  it("holds model, maxSteps and exec constant across arms", () => {
    for (const v of variants) {
      expect(v.record.modelId).toBe("gpt-5.6-sol");
      expect(v.record.maxSteps).toBe(20);
      expect(v.record.exec).toBeUndefined();
      expect(v.record.instructions).toBe(composed[COMPOSE_AS[v.variant]]);
    }
    // Four prompts across five arms: A′ is arm A's prompt, so they share a sha.
    expect(new Set(variants.map((v) => v.promptSha8)).size).toBe(4);
  });

  it("A′ differs from A in nothing but the card the runner prefixes", () => {
    const a = buildVariant("A");
    const ap = buildVariant("AP");
    expect(ap.record.instructions).toBe(a.record.instructions);
    expect(ap.promptSha8).toBe(a.promptSha8);
    expect(ap.record.connections).toEqual([]);
    expect(approvalFor("AP")).toEqual({});
    expect(ap.record.modelId).toBe(a.record.modelId);
    expect(ap.record.maxSteps).toBe(a.record.maxSteps);
    // Distinct records under the eval principal, so the cohorts never share a thread history.
    expect(ap.record.name).not.toBe(a.record.name);
    expect(agentNameFor("AP")).toBe("edge-eval-a-prime");
    // The card is what makes A′ A′ — and only A′ gets it.
    expect([...CARD_ARMS]).toEqual(["AP"]);
    // Every arm is buildable and named once.
    expect(new Set(ARMS.map(agentNameFor)).size).toBe(ARMS.length);
  });
});
