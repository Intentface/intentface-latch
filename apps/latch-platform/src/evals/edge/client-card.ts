/**
 * Edge Eval v0 — the A′ arm's CLIENT CARD (plan: "approved flow improvements", item 2).
 *
 * A is the guide's vanilla baseline: a good prompt and nothing else. It loses to D partly
 * because it cannot know the client at all, which is not a fair read of "does the product
 * beat a good generic model" — outside this building, someone comparing Edge to ChatGPT
 * would paste a paragraph about their company first. A′ is that comparison: the SAME prompt
 * and no connections, with a fixed 5–6 sentence card prefixed to the turn-1 question.
 *
 * The card is built ONCE at sweep start from the live client plane and reused verbatim for
 * every case, so no per-case leakage can creep in: it says what the client is, its stage in
 * plain words, the two live agent surfaces, the binding capacity constraint and the stated
 * priorities. Sections used (the plan names placement Summary + product "What it is"; the
 * other three are where the remaining named facts actually live):
 *   placement  ## Summary
 *   product    ## What it is · ## AI and agentic features live today
 *   strategy   ## Funding and constraints · ## Stated priorities
 *
 * Compression needs a model — the raw sections are ~1500 words and would make A′ a second
 * horizontal arm rather than a baseline. The writer is the JUDGE family (Claude), not the
 * app model, so the card is not the arm's own model priming itself; the text, its sha8 and
 * the writer model are stamped into the run's summary.json and the card is cached in the
 * run directory, so a `--resume` continues with the identical card. Nothing is stored in
 * the repo: the card is client-plane content (memory `edge-client-workspace-read-only`).
 */
import { createHash } from "node:crypto";
import { generateText, type LanguageModel } from "ai";
import { CONNECTIONS } from "./variants";
import { readViaConnection, section, type Opened } from "./judge/reference";

/** Which sections of which ctx files the card may be built from — the whole input, listed. */
export const CARD_SOURCES: Array<{ file: string; sections: string[] }> = [
  { file: "edge/ctx/placement.md", sections: ["Summary"] },
  { file: "edge/ctx/product.md", sections: ["What it is", "AI and agentic features live today"] },
  { file: "edge/ctx/strategy.md", sections: ["Funding and constraints", "Stated priorities"] },
];

export const CARD_WRITER_INSTRUCTION = `Below are extracts from a company's own internal context notes.

Write a short paragraph of FIVE OR SIX sentences that a person from this company might type at the top of a chat to an outside AI advisor before asking a question — the background they would give a stranger.

It must cover, in this order:
1. what the company is and sells;
2. where it currently stands with AI/agents, in plain words (no internal grading vocabulary);
3. the two AI surfaces already live in the product;
4. the constraint that binds them;
5. what they say their priorities are.

Rules: plain prose in the first person plural ("we"), no headings, no bullets, no markdown, no title. Only facts from the extracts — invent nothing, add no advice, no recommendation and no judgement about what they should do next. Do not mention these notes, this instruction, or any file. Output the paragraph and nothing else.`;

export interface ClientCard {
  text: string;
  sha8: string;
  writer_model: string;
  sources: Array<{ file: string; section: string; chars: number }>;
  built_at: string;
}

export const cardSha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** Read the source sections live through an open `edge-client` connection. */
export async function readCardSources(client: Opened): Promise<Array<{ file: string; section: string; text: string }>> {
  const out: Array<{ file: string; section: string; text: string }> = [];
  for (const src of CARD_SOURCES) {
    const md = await readViaConnection(client, `${CONNECTIONS.client}_read_file`, src.file);
    for (const s of src.sections) {
      const text = section(md, s);
      if (!text) throw new Error(`client card: ${src.file} has no "## ${s}" section — the plane changed, re-check CARD_SOURCES`);
      out.push({ file: src.file, section: s, text });
    }
  }
  return out;
}

/** Build the card. One model call; the caller caches the result for the whole sweep. */
export async function buildClientCard(client: Opened, model: LanguageModel, writerModelId: string): Promise<ClientCard> {
  const sources = await readCardSources(client);
  const extracts = sources.map((s) => `--- ${s.file} · ## ${s.section} ---\n${s.text}`).join("\n\n");
  const { text } = await generateText({
    model,
    messages: [{ role: "user", content: `${CARD_WRITER_INSTRUCTION}\n\n=== EXTRACTS ===\n${extracts}` }],
    maxOutputTokens: 2000,
  });
  // Unwrap only a card the writer wrapped in quotes as a whole — a one-sided strip would eat
  // the closing quote of a card that ends on a quoted phrase ("doing more with AI.").
  const trimmed = text.trim();
  const card = /^"[\s\S]*"$/.test(trimmed) || /^'[\s\S]*'$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  if (!card) throw new Error("client card: the writer returned nothing");
  return {
    text: card,
    sha8: cardSha8(card),
    writer_model: writerModelId,
    sources: sources.map((s) => ({ file: s.file, section: s.section, chars: s.text.length })),
    built_at: new Date().toISOString(),
  };
}

/** How the card reaches the arm: prefixed to the turn-1 question only (turn 2 rides the thread). */
export function withClientCard(card: string, question: string): string {
  return `Background on us, for context:\n\n${card}\n\nMy question:\n\n${question}`;
}
