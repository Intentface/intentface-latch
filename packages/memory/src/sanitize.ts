/**
 * Injection hardening for memory-derived text.
 *
 * Everything under a memory scope is LLM-authored from user conversation
 * (extraction/consolidation), which makes stored memory a prompt-injection
 * PERSISTENCE vector: a hostile conversation can plant text that later lands
 * verbatim in another turn's system prompt (the injected index block) or in
 * tool results (search snippets). Two layers, applied at injection time:
 *
 *  1. envelope integrity — tag-shaped text that could close/reopen the
 *     `<memory>` data envelope or fake system/instruction framing is removed;
 *  2. a NAMED blocklist of well-known injection phrasings is replaced with
 *     `[filtered]`.
 *
 * HONESTY: this is volume reduction, NOT a guarantee. A blocklist cannot
 * enumerate every phrasing, and a determined attacker will word around it.
 * The durable defenses are the data envelope plus the standing "memory is
 * data, not instructions" instruction — this pass just removes the cheap,
 * well-known payloads. Patterns are kept tight so benign memory text
 * (including text that merely MENTIONS instructions) passes unchanged.
 */

/**
 * Tag-shaped text that could terminate/forge the data envelope or smuggle
 * role framing: `</memory>`, `<system>`, `<instructions>`, chat-template
 * markers (`<|im_start|>`, `[INST]`, `<<SYS>>`), etc. Removed outright —
 * memory content has no legitimate use for these.
 */
const ENVELOPE_BREAK_PATTERNS: readonly RegExp[] = [
  // XML-ish open/close tags for the envelope and role/instruction framing.
  /<\s*\/?\s*(?:memory|system|instructions?|assistant|developer|prompt|sys)\b[^>]*>/gi,
  // ChatML-style special tokens: <|im_start|>, <|system|>, <|endoftext|>, …
  /<\|[^|>]{1,32}\|>/g,
  // Llama-style framing: [INST] … [/INST], <<SYS>> … <</SYS>>.
  /\[\s*\/?\s*INST\s*\]/gi,
  /<<\s*\/?\s*SYS\s*>>/gi,
];

/**
 * Known injection phrasings, each named so the corpus test pins them
 * one-by-one. Every pattern requires imperative/role context — "ignore" or
 * "instructions" alone never match.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    // "ignore/disregard/forget/override/bypass [all/any/the/your]
    //  [previous/prior/above/…] instructions/prompt/rules/…"
    name: "override-prior-instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|every)\s+)?(?:(?:previous|prior|above|earlier|preceding|original|initial|system|safety)\s+)?(?:instructions?|prompts?|directives?|rules?|guidelines?|context|messages?)\b/gi,
  },
  { name: "new-instructions-colon", pattern: /\bnew\s+instructions?\s*:/gi },
  {
    name: "your-instructions-are",
    pattern: /\byour\s+(?:real\s+|true\s+|actual\s+|new\s+)?instructions?\s+are\b/gi,
  },
  { name: "system-role-claim", pattern: /\bsystem\s*:\s*you\s+are\b/gi },
  { name: "you-are-now", pattern: /\byou\s+are\s+now\b/gi },
  { name: "developer-mode", pattern: /\bdeveloper\s+mode\b/gi },
  { name: "dan-do-anything-now", pattern: /\bdo\s+anything\s+now\b/gi },
  { name: "dan-persona", pattern: /\b(?:you\s+are|act\s+as)\s+DAN\b/gi },
  { name: "dan-mode", pattern: /\bDAN\s+mode\b/g },
  { name: "jailbreak-mode", pattern: /\bjailbreak\s+(?:mode|prompt)\b/gi },
];

const FILTERED = "[filtered]";

/**
 * Neutralize envelope breakouts and strip known injection phrasings from
 * memory-derived text. Apply wherever stored memory re-enters a prompt (the
 * compiled index block, search snippets). Idempotent; leaves benign text —
 * including ordinary mentions of "instructions" — untouched.
 */
export function sanitizeMemoryText(text: string): string {
  let out = text;
  // To a fixpoint (bounded): stripping can reassemble a payload from its
  // halves ("<sys<system>tem>" → "<system>"), so one pass is bypassable.
  for (let i = 0; i < 8; i++) {
    const before = out;
    // Tags are replaced with a space, not "": removing them outright would
    // splice their neighbors together, both reassembling split tags and
    // fusing words across a stripped tag so phrase patterns miss them.
    for (const pattern of ENVELOPE_BREAK_PATTERNS) out = out.replace(pattern, " ");
    for (const { pattern } of INJECTION_PATTERNS) out = out.replace(pattern, FILTERED);
    if (out === before) return out;
  }
  // Still churning after the bound — refuse to inject what we can't settle.
  return "(memory text withheld: sanitizer did not converge)";
}
