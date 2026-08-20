/**
 * Prompt-caching plans: which provider options a turn should set so the model
 * provider caches the stable prompt prefix (tool definitions, system prompt,
 * conversation history) instead of re-billing it every step.
 *
 * Kept provider-generic in core: the PLATFORM decides which provider a model id
 * belongs to (it owns the catalog) and calls `promptCachingPlanFor` from its
 * `RuntimeConfig.resolvePromptCaching` hook; core only applies the plan in
 * `buildTurn`. Providers not named here (e.g. Google: implicit caching only)
 * get no plan and are untouched.
 *
 * Anthropic layout — three of the four allowed `cache_control` breakpoints:
 *  1. The LAST function tool definition. Tools render before the system prompt
 *     in the request, so this keeps the (often large, MCP-heavy) tool prefix
 *     cached even when the system block changes mid-conversation (e.g. a
 *     memory-index write).
 *  2. The system message that holds the agent instructions + memory block. The
 *     day-granular date line is a SEPARATE, unmarked system message after it,
 *     so the daily date flip never invalidates this breakpoint.
 *  3. A request-level (top-level) `cache_control` — Anthropic's automatic
 *     caching: the API places a breakpoint on the last cacheable block of the
 *     request. The AI SDK re-sends call-level providerOptions on every step of
 *     the tool loop, so this breakpoint ROLLS to the newest tool result with no
 *     per-step code. Note: top-level cache_control is a first-party Claude API
 *     feature (not Bedrock/Vertex); block-level markers work everywhere. Also
 *     note the SDK's client-side breakpoint validator counts only block-level
 *     markers, so the request-level one is invisible to it — harmless.
 *
 * TTL is left at the provider default (5m). Agents whose turns arrive slower
 * than that won't benefit — that's surfaced by the platform's caching lint,
 * not worked around here.
 */

/** A cache-control marker in the shape the Anthropic provider expects. */
const EPHEMERAL = { type: "ephemeral" } as const;

export interface PromptCachingPlan {
  /**
   * Call-level providerOptions (merged with e.g. reasoning options). Anthropic:
   * the rolling request-level breakpoint. OpenAI: `promptCacheKey` for cache
   * routing (OpenAI caches automatically; the key only improves shard routing).
   */
  requestProviderOptions?: Record<string, Record<string, unknown>>;
  /**
   * providerOptions for the system message carrying the agent instructions.
   * Presence also signals `buildTurn` to split the system prompt into two
   * messages so volatile trailing content (the date line) lands AFTER the
   * breakpoint.
   */
  systemProviderOptions?: Record<string, Record<string, unknown>>;
  /**
   * providerOptions to place on the LAST active function tool definition
   * (a breakpoint covering the whole tools prefix). Applied via
   * `markLastFunctionTool`.
   */
  toolProviderOptions?: Record<string, Record<string, unknown>>;
}

/**
 * The caching plan for a provider family (`"anthropic"`, `"openai"`, …).
 * `cacheKeySuffix` scopes OpenAI's cache routing key beyond the agent name —
 * pass a per-principal key for agents whose system prompt is per-principal
 * (e.g. memory-enabled agents), so structurally different prefixes don't
 * co-route to one shard.
 */
export function promptCachingPlanFor(
  provider: string | undefined,
  opts: { agent: string; cacheKeySuffix?: string },
): PromptCachingPlan | undefined {
  if (provider === "anthropic") {
    return {
      requestProviderOptions: { anthropic: { cacheControl: { ...EPHEMERAL } } },
      systemProviderOptions: { anthropic: { cacheControl: { ...EPHEMERAL } } },
      toolProviderOptions: { anthropic: { cacheControl: { ...EPHEMERAL } } },
    };
  }
  if (provider === "openai") {
    const key = opts.cacheKeySuffix
      ? `latch:agent:${opts.agent}:${opts.cacheKeySuffix}`
      : `latch:agent:${opts.agent}`;
    // OpenAI caps prompt_cache_key at 64 chars and 400s the whole turn past
    // it — agent names and principal keys are unbounded, so an over-long key
    // collapses to a deterministic hash of the full key material (routing
    // only needs stability, not readability).
    const bounded = key.length <= 64 ? key : `latch:${fnv1a64(key)}`;
    return { requestProviderOptions: { openai: { promptCacheKey: bounded } } };
  }
  return undefined;
}

/** FNV-1a 64-bit over a string — dependency-free stable fingerprint. */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * One-level-deep merge of providerOptions objects (per provider key), so e.g.
 * `{ anthropic: { thinking } }` from reasoning and `{ anthropic: { cacheControl } }`
 * from caching coexist — a plain spread would clobber one with the other. Later
 * sources win on conflicting inner keys. Returns undefined when nothing to merge.
 */
export function mergeProviderOptions(
  ...sources: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const present = sources.filter((s): s is Record<string, unknown> => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const out: Record<string, unknown> = {};
  for (const source of present) {
    for (const [provider, options] of Object.entries(source)) {
      const prev = out[provider];
      out[provider] =
        prev && typeof prev === "object" && options && typeof options === "object"
          ? { ...(prev as object), ...(options as object) }
          : options;
    }
  }
  return out;
}

/**
 * Stable fingerprint of a toolset (FNV-1a 64-bit over the sorted names) —
 * equality is all that matters (same hash ⇔ same tool names), so a
 * dependency-free non-cryptographic hash beats pulling in node:crypto (core
 * stays runtime-agnostic). Stored on the run row to detect toolset churn
 * across a chat's turns, one of the main prompt-cache invalidators.
 */
export function toolsetHash(names: Iterable<string>): string {
  return fnv1a64([...names].sort().join(","));
}

/**
 * Mark the LAST active function tool with the given providerOptions (in place).
 * Skips provider-executed tools (`type: "provider"`, e.g. Anthropic's native
 * web_search/web_fetch) — the provider silently drops `cache_control` on those —
 * and, when `activeNames` is given, tools the turn filtered out via
 * `activeTools` (a marker on an unsent tool would vanish). Returns the marked
 * tool name, or undefined when no eligible tool exists.
 */
export function markLastFunctionTool(
  tools: Record<string, unknown>,
  providerOptions: Record<string, Record<string, unknown>>,
  activeNames?: readonly string[],
): string | undefined {
  const active = activeNames ? new Set(activeNames) : undefined;
  const names = Object.keys(tools);
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]!;
    if (active && !active.has(name)) continue;
    const t = tools[name] as { type?: string; providerOptions?: Record<string, unknown> };
    if (!t || typeof t !== "object") continue;
    // "provider" (and any future provider-executed variant) can't carry
    // cache_control; everything else (function/dynamic) serializes as a
    // client tool definition and can.
    if (typeof t.type === "string" && t.type.startsWith("provider")) continue;
    tools[name] = {
      ...(t as object),
      providerOptions: mergeProviderOptions(t.providerOptions, providerOptions),
    };
    return name;
  }
  return undefined;
}
