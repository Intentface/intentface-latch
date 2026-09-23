/**
 * Evals v2 — error discovery: read threads, say what went wrong, then find
 * the patterns. It comes BEFORE checks: a check written before anyone has
 * seen a failure measures what someone imagined, and ours proved it — one
 * passed 100% on both versions and told us nothing.
 *
 * A note is a person's free-text account of the first thing that went wrong
 * in a thread, from the user's side. "Looks fine" is a note too: it says the
 * thread was read. Notes cluster into failure modes; a failure mode becomes
 * a check, and the notes behind it become that check's first rulings, so a
 * check born from real failures starts with evidence, not at zero.
 */
import { z } from "zod";

export interface Note {
  owner: string;
  threadId: string;
  agentName: string;
  datasetId?: string;
  /** What went wrong. Empty when `ok`. */
  text: string;
  /** Read, and nothing was wrong. */
  ok: boolean;
  /** The failure mode it was grouped into, if any. */
  modeId?: string;
  by?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FailureMode {
  owner: string;
  agentName: string;
  id: string;
  name: string;
  /** What the failure looks like, in a sentence, from the user's side. */
  description: string;
  createdAt: number;
}

/** The article's bar: learning keeps coming until about a hundred threads. */
export const READ_TARGET = 100;
/** Patterns need material; below this, grouping is guesswork. */
export const MIN_NOTES_TO_CLUSTER = 5;

export const ClusterSchema = z.object({
  modes: z
    .array(
      z.object({
        name: z.string().describe("Short name a product person would use, e.g. 'Recommends overlay widgets'"),
        description: z.string().describe("One sentence: what the user experiences when this happens"),
        notes: z.array(z.number().int()).describe("Numbers of the notes that show this failure"),
      }),
    )
    .describe("Failure modes, most common first"),
});

export function clusterPrompt(opts: { agentName: string; notes: { text: string }[]; existing: { name: string; description: string }[] }) {
  const list = opts.notes.map((n, i) => `${i + 1}. ${n.text.replace(/\s+/g, " ").trim()}`).join("\n");
  const existing = opts.existing.length
    ? `\nFailure modes named before — keep these names where they still fit, so counts stay comparable:\n${opts.existing.map((m) => `- ${m.name}: ${m.description}`).join("\n")}\n`
    : "";
  return `People reviewed conversations with the AI agent "${opts.agentName}" and wrote down the first thing that went wrong in each.
Group the notes into failure modes: recurring ways the agent fails its users.

Rules:
- Group by what the USER experiences, not by guessed internal cause.
- A mode needs at least two notes, unless a single note is severe and clearly distinct.
- Each note belongs to at most one mode. Leave a note out if it fits nowhere.
- Names are short and concrete ("Cites no source for regulatory claims"), never generic ("Quality issues").
${existing}
Notes:
${list}`;
}

/**
 * Keep what a model returned honest: note numbers in range, each note in at
 * most one mode (first claim wins), modes with no notes dropped.
 */
export function cleanClusters(raw: z.infer<typeof ClusterSchema>, noteCount: number) {
  const taken = new Set<number>();
  const modes = raw.modes
    .map((m) => ({
      name: m.name.trim(),
      description: m.description.trim(),
      notes: [...new Set(m.notes)]
        .filter((n) => n >= 1 && n <= noteCount && !taken.has(n))
        .map((n) => (taken.add(n), n - 1)),
    }))
    .filter((m) => m.name && m.notes.length);
  return modes.sort((a, b) => b.notes.length - a.notes.length);
}

export const CheckDraftSchema = z.object({
  label: z.string().describe("What passing means, as the results grid will show it, e.g. 'Offers a cheaper option when budget matters'"),
  ask: z
    .string()
    .describe("A yes/no question for a judge reading the thread, phrased so YES means the agent did well"),
});

export function checkPrompt(opts: { agentName: string; mode: { name: string; description: string }; examples: string[] }) {
  return `A failure mode was found by reading conversations with the AI agent "${opts.agentName}":

${opts.mode.name}: ${opts.mode.description}

What reviewers wrote about it:
${opts.examples.map((e) => `- ${e.replace(/\s+/g, " ").trim()}`).join("\n")}

Write a check that catches it: a yes/no question a judge answers by reading one conversation (the question, the tools the agent used, its answer, and a reference answer when there is one).
- Phrase it so YES means the agent did well.
- Make it decidable from the conversation alone. If the failure depends on context the judge will not see, say what to look for in the conversation instead.
- Plain English, one or two sentences. No scoring rubric.`;
}
