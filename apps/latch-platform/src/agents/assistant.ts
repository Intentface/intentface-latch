import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import { defineAgent } from "@intentface/latch-core";
import type { Principal } from "@/lib/session";

/**
 * The platform's assistant — fully declarative. It names the connections it may
 * use (`connections`); the runtime resolves those to the org's authorized MCP
 * tools, plus a `connect_<name>` tool that pauses the turn for OAuth when one
 * isn't connected yet (then auto-resumes).
 */
export const assistant = defineAgent<Principal, { orgId: string }>({
  model: anthropic("claude-sonnet-4-6"),
  instructions:
    "You are Latch's helpful, concise assistant. To charge a customer, call " +
    "chargeCustomer — it requires human approval before it runs. For questions " +
    "about the user's documents, use the Loredex knowledge-base tools " +
    "(loredex_*). If those tools aren't available yet, call connect_loredex to " +
    "ask the user to connect Loredex, then continue once they have.",
  // `custom` is a late-bound name: it does nothing until the user adds a
  // connection named "custom" on the Connections page (MCP or OpenAPI).
  connections: ["loredex", "custom"],
  // Even out the visible token cadence in the chat UI (cosmetic).
  smoothStream: true,
  tools: {
    chargeCustomer: tool({
      description: "Charge a customer's card (sensitive — needs approval).",
      inputSchema: z.object({
        customer: z.string(),
        amountUsd: z.number(),
      }),
      execute: async ({ customer, amountUsd }) => ({
        charged: true,
        customer,
        amountUsd,
        reference: `ch_${Math.round(amountUsd * 100)}`,
      }),
    }),
  },
  // HITL: the turn pauses (awaiting_input) until the user approves.
  toolApproval: { chargeCustomer: "user-approval" },
}, {
  title: "Assistant",
  description: "General-purpose assistant with Loredex knowledge base and a billing tool.",
});
