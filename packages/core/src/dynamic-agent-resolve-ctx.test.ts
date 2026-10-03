import { describe, expect, it } from "vitest";
import { createRuntime, type DynamicAgentResolveContext } from "./runtime.js";
import { defineContext } from "./context.js";
import type { ChatRecord, StorageAdapter } from "./storage.js";

/**
 * A dynamic agent is resolved with the turn's `DynamicAgentResolveContext`:
 * the `parentAgent` persisted on the sub-thread and whether the turn runs
 * unattended. The parent is read off the CHAT record, not the call — that is
 * what keeps a per-parent shaping (e.g. which connector tools a given agent
 * may use) in force on a continued thread, not just the first turn.
 *
 * `runAgent` hosts the path: it reaches `dynamicAgents.resolve` after the chat
 * lookup and before any model call, so returning `undefined` ends the run
 * with "Unknown agent" and no model is needed.
 */

type P = { userId: string };
const ME: P = { userId: "u1" };

function chatRecord(parentAgent: string | undefined): ChatRecord {
  return {
    id: "sub_1",
    owner: "u1",
    agent: "connector",
    kind: "internal",
    parentAgent,
    createdAt: 0,
    updatedAt: 0,
  };
}

function storageWith(chat: ChatRecord): StorageAdapter<P> {
  const overrides: Partial<StorageAdapter<P>> = {
    getChat: async () => chat,
    loadMessages: async () => [],
    appendMessages: async () => {},
  };
  return new Proxy({} as StorageAdapter<P>, {
    get(_t, prop: string) {
      if (prop in overrides) return overrides[prop as keyof StorageAdapter<P>];
      return () => {
        throw new Error(`storage.${prop} should not be called by this path`);
      };
    },
  });
}

async function resolveCtxFor(chat: ChatRecord): Promise<{
  args: { name: string; ctx: DynamicAgentResolveContext | undefined } | undefined;
}> {
  const seen: { name: string; ctx: DynamicAgentResolveContext | undefined }[] = [];
  const rt = createRuntime<P>({
    storage: storageWith(chat),
    context: defineContext<P, unknown>({ build: async () => ({}) }),
    agents: {},
    dynamicAgents: {
      list: async () => [],
      resolve: (name, _principal, ctx) => {
        seen.push({ name, ctx });
        return undefined;
      },
    },
  });
  await expect(
    rt.runAgent({ principal: ME, agent: "connector", prompt: "hi", threadId: chat.id }),
  ).rejects.toThrow("Unknown agent: connector");
  return { args: seen[0] };
}

describe("DynamicAgentStore.resolve receives the turn's resolve context", () => {
  it("passes the parentAgent persisted on the sub-thread, and autoApprove for a headless run", async () => {
    const { args } = await resolveCtxFor(chatRecord("weekly-report"));
    expect(args).toEqual({
      name: "connector",
      ctx: { parentAgent: "weekly-report", autoApprove: true },
    });
  });

  it("leaves parentAgent undefined for a thread nobody spawned", async () => {
    const { args } = await resolveCtxFor(chatRecord(undefined));
    expect(args?.ctx).toEqual({ parentAgent: undefined, autoApprove: true });
  });
});
