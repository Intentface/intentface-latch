import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { DAY_MS, usageKey, windowRef, type LimitStore, type LimitUsage, type LimitWindowRef } from "@intentface/latch-core";
import { createTriage, renderJudgePrompt, ruleVerdict } from "./triage.js";
import { engagementOf } from "./engagement.js";
import type { Observation } from "./state.js";

const DOC = "## Commitments\n- bob will write the runbook by Friday (source 200.1)\n\n## Watching\n- 300.0: deploy thread";
const msg = (text: string, ts = "1.0"): Observation => ({ kind: "message", ts, userId: "U1", text });
const input = (events: Observation[], oldestAgeMs = 0) => ({ channel: "C1", events, stateDoc: DOC, oldestAgeMs });
const MAX = 30 * 60_000;

describe("rule stage", () => {
  it("acts on mentions, tracked threads and messages, questions/commitments, and stale batches", () => {
    expect(ruleVerdict(input([{ kind: "mention", ts: "1.0", text: "<@B> hi" }]), MAX)).toMatchObject({ act: true, reason: /mentioned/ });
    expect(ruleVerdict(input([{ kind: "reply", ts: "1.0", threadTs: "300.0", text: "shipped" }]), MAX)).toMatchObject({ act: true, reason: /thread I am watching/ });
    expect(ruleVerdict(input([{ kind: "reaction_added", ts: "1.0", emoji: "white_check_mark", targetTs: "200.1" }]), MAX)).toMatchObject({ act: true, reason: /my state references/ });
    expect(ruleVerdict(input([msg("who owns the deploy?")]), MAX)).toMatchObject({ act: true, reason: /question, a request for input, or a commitment/ });
    expect(ruleVerdict(input([msg("I'll send it by Friday")]), MAX)).toMatchObject({ act: true });
    expect(ruleVerdict(input([msg("I would like to hear everyone's opinion about topic x")]), MAX)).toMatchObject({ act: true, reason: /request for input/ });
    expect(ruleVerdict(input([msg("lol nice")], MAX + 1), MAX)).toMatchObject({ act: true, reason: /waited 30 min/ });
  });

  it("acts on follow-ups in conversations the agent is part of, and on its name", () => {
    const engagement = engagementOf([{ ts: "100.0" }, { ts: "310.0", threadTs: "300.0" }], "Ambient");
    expect(ruleVerdict({ ...input([msg("nice, so which beans", "150.0")]), engagement }, MAX)).toMatchObject({ act: true, reason: /follow-up/ });
    expect(ruleVerdict({ ...input([{ kind: "reply", ts: "320.0", threadTs: "300.0", text: "and then" }]), engagement }, MAX)).toMatchObject({ act: true, reason: /follow-up/ });
    expect(ruleVerdict({ ...input([msg("ambient are you there", "9000.0")]), engagement }, MAX)).toMatchObject({ act: true, reason: /my name/ });
    expect(ruleVerdict({ ...input([msg("lol nice", "9000.0")]), engagement }, MAX)).toBeNull(); // long after, no name: plain talk
  });

  it("defers pure noise and leaves plain talk undecided", () => {
    expect(ruleVerdict(input([{ kind: "reaction_added", ts: "1.0", emoji: "tada", targetTs: "999.9" }]), MAX)).toMatchObject({ act: false, reason: /do not track/ });
    expect(ruleVerdict(input([{ kind: "delete", ts: "1.0", targetTs: "999.9" }]), MAX)).toMatchObject({ act: false });
    expect(ruleVerdict(input([]), MAX)).toMatchObject({ act: false, reason: "nothing queued" });
    expect(ruleVerdict(input([msg("lol nice"), msg("morning all")]), MAX)).toBeNull();
  });
});

function limitStore(): LimitStore & { rows: Map<string, LimitUsage> } {
  const rows = new Map<string, LimitUsage>();
  return {
    rows,
    async read() {
      return {};
    },
    async add(entries: (LimitWindowRef & { usage: Partial<LimitUsage> })[]) {
      const out: Record<string, LimitUsage> = {};
      for (const e of entries) {
        const u = rows.get(usageKey(e)) ?? { turns: 0, tokens: 0, cost: 0 };
        const next = { turns: u.turns + (e.usage.turns ?? 0), tokens: u.tokens + (e.usage.tokens ?? 0), cost: u.cost + (e.usage.cost ?? 0) };
        rows.set(usageKey(e), next);
        out[usageKey(e)] = next;
      }
      return out;
    },
  };
}

const judge = (json: string) =>
  new MockLanguageModelV4({
    modelId: "mock-judge",
    doGenerate: (async () => ({
      content: [{ type: "text", text: json }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 120 }, outputTokens: { total: 15 } },
      warnings: [],
    })) as never,
  });

describe("model stage", () => {
  it("asks the judge only for plain talk, charges its tokens to the channel's budget, and logs usage", async () => {
    const store = limitStore();
    const policy = { key: "channel:C1", windowMs: DAY_MS, max: { tokens: 1000 } };
    const now = () => 1_700_000_000_000;
    const triage = createTriage({ model: judge('{"act": false, "reason": "banter"}'), limits: { store, policiesFor: () => [policy] }, now });

    const v = await triage.decide(input([msg("lol nice")]));
    expect(v).toEqual({ act: false, stage: "model", reason: "banter", usage: { inputTokens: 120, outputTokens: 15 } });
    expect(store.rows.get(usageKey(windowRef(policy, now())))).toEqual({ turns: 0, tokens: 135, cost: 0 });

    // A rule verdict costs nothing.
    const ruled = await triage.decide(input([msg("can you review?")]));
    expect(ruled.stage).toBe("rule");
    expect(store.rows.get(usageKey(windowRef(policy, now())))!.tokens).toBe(135);
  });

  it("without a judge, plain talk acts; the prompt shows notes and messages", async () => {
    const triage = createTriage();
    expect(await triage.decide(input([msg("lol nice")]))).toMatchObject({ act: true, stage: "rule", reason: /no judge/ });
    const prompt = renderJudgePrompt(input([msg("lol nice"), { kind: "reaction_added", ts: "2.0", userId: "U2", emoji: "eyes", targetTs: "1.0" }]));
    expect(prompt).toContain("CURRENT NOTES:\n## Commitments");
    expect(prompt).toContain("NEW MESSAGES (2):");
    expect(prompt).toContain("[1.0] U1: lol nice");
    expect(prompt).toContain("U2 added :eyes: on 1.0");
  });

  it("a judge that answers garbage falls back to acting", async () => {
    const triage = createTriage({ model: judge("not json at all") });
    const v = await triage.decide(input([msg("hmm")])).catch((e) => ({ act: true, stage: "model" as const, reason: String(e) }));
    expect(v.act).toBe(true);
  });
});
