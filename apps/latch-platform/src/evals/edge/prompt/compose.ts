/**
 * Edge Eval v0 — compose one ablation variant's instructions from the tagged prompt.
 *
 * `edge-v2.prompt.md` is ONE file whose segments are opened by marker lines
 * `<!-- @@ TAG [TAG …] -->`. A tag is a block name (SHARED / HORIZONTAL /
 * VERTICAL_KN / INBOX / BOTH_ONLY) or a bare variant letter; a segment lands in
 * a variant when any tag covers it. The variants are therefore a selection over
 * segments — never four hand-maintained prompts (plan Step 1).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const VARIANTS = ["A", "B", "C", "D"] as const;
export type Variant = (typeof VARIANTS)[number];

/** Block → the variants it is present in. Bare letters are their own tag. */
export const BLOCKS: Record<string, readonly Variant[]> = {
  SHARED: ["A", "B", "C", "D"],
  HORIZONTAL: ["B", "D"],
  VERTICAL_KN: ["C", "D"],
  INBOX: ["D"],
  BOTH_ONLY: ["D"],
  A: ["A"],
  B: ["B"],
  C: ["C"],
  D: ["D"],
};

export interface Segment {
  /** 1-based line of the marker in the prompt file (for test failure messages). */
  line: number;
  tags: string[];
  variants: Set<Variant>;
  /** Raw lines between this marker and the next — leading/trailing blanks preserved. */
  lines: string[];
  text: string;
}

const MARKER = /^<!--\s*@@\s+([A-Z_ ]+?)\s*-->\s*$/;
const HEADER_COMMENT = /^<!--(?![ \t]*@@)[\s\S]*?-->\s*\n/;

export const PROMPT_PATH = new URL("./edge-v2.prompt.md", import.meta.url);

/** Split the tagged file into segments. Text before the first marker must be only the header comment. */
export function parseSegments(source: string = readFileSync(PROMPT_PATH, "utf8")): Segment[] {
  const body = source.replace(HEADER_COMMENT, "");
  const lines = body.split("\n");
  const segments: Segment[] = [];
  let current: Segment | undefined;
  const headerLines = source.split("\n").length - lines.length;
  lines.forEach((raw, i) => {
    const m = MARKER.exec(raw);
    if (m) {
      const tags = m[1]!.trim().split(/\s+/);
      const variants = new Set<Variant>();
      for (const t of tags) {
        const vs = BLOCKS[t];
        if (!vs) throw new Error(`edge-v2.prompt.md:${headerLines + i + 1}: unknown tag "${t}"`);
        vs.forEach((v) => variants.add(v));
      }
      current = { line: headerLines + i + 1, tags, variants, lines: [], text: "" };
      segments.push(current);
      return;
    }
    if (!current) {
      if (raw.trim()) throw new Error(`edge-v2.prompt.md:${headerLines + i + 1}: text before the first marker`);
      return;
    }
    current.lines.push(raw);
  });
  for (const s of segments) s.text = s.lines.join("\n");
  return segments;
}

/**
 * The composed system prompt for one variant. Runs of 3+ blank lines collapse to 2,
 * and the procedure's `## N.` headings are renumbered consecutively — a variant that
 * drops steps (A has no memory write, no pillar pull) must not read "1, 4, 5, 8".
 * D keeps all eight, so its numbering is unchanged.
 */
export function composeInstructions(variant: Variant, segments: Segment[] = parseSegments()): string {
  const text = segments
    .filter((s) => s.variants.has(variant))
    .map((s) => s.text)
    .join("\n");
  let step = 0;
  return (
    text
      .replace(/\n{4,}/g, "\n\n\n")
      .replace(/^## \d+\. /gm, () => `## ${++step}. `)
      .replace(/^\n+/, "")
      .replace(/\s+$/, "") + "\n"
  );
}

/** Eight hex chars of the composed prompt — stamped as `prompt:<sha8>` on every run. */
export function promptSha8(variant: Variant, segments?: Segment[]): string {
  return createHash("sha256").update(composeInstructions(variant, segments)).digest("hex").slice(0, 8);
}
