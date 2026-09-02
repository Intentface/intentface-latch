import { anthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { z } from "zod";
import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { isOrgAdmin } from "@/lib/auth";

/**
 * Builder extension: memory index schemas. The record schema already enforces
 * the memory invariants (connection wired, org-shared memory needs an org
 * agent, outlines ≤ 4000 chars); this adds the drafting tool, the org-wide
 * user-level schema file, and the platform's reserved `memory-*` name prefix.
 */

/** A real level-2 heading (`## ` + text) somewhere in the outline. */
const isOutline = (s: string) => /^[ \t]*##(?!#)[ \t]+\S/m.test(s);

const PROMPT = `MEMORY & SCHEMAS (exec.memory + generate_memory_schemas / save_user_memory_schema):
An agent with exec.memory remembers across sessions: the platform archives durable facts from idle chats in the background, injects a compiled index (MEMORY.md) each turn, and adds memory_search/memory_save. Memory has LEVELS, each a separate store with its own audience:
- "agent-user" — this agent's private memory of each user (the default primary scope).
- "agent-org" — one store shared by the whole org (requires the agent's scope to be "org"). Policy floor: NO PII, no named individuals — aggregate patterns only.
- "user" — the user's cross-agent profile, shared by ALL their agents. Profile-level facts only.
Besides its primary scope, an agent can extract into more levels via exec.memory.extractTo (e.g. an interview agent files per-person notes at agent-user AND team-level patterns at agent-org). The memory connection must be one of the agent's connections (typically 'loredex').
Each level can carry an INDEX SCHEMA — a markdown outline of "## Section" headings (+ one description bullet each) steering WHAT gets archived at that level and HOW its index is organized. A domain-specific schema is what makes memory genuinely useful — offer one whenever you enable memory:
1. Call generate_memory_schemas with the agent's instructions and the levels; show the drafts to the user and apply their edits.
2. Attach the agent-held levels via save_agent exec.memory.schemas ("agent-user"/"agent-org" only).
3. A "user"-level schema is NOT agent config — it is one org-wide workspace file shared by all agents; save it with save_user_memory_schema (approval-gated) and only when the user explicitly wants to shape the cross-agent profile.
Each level also has a fixed policy floor baked into the platform (the org level's no-PII rule above) — schemas add domain guidance on top and can never relax it.`;

export const memoryExtension: AgentBuilderExtension<Principal> = {
  name: "memory",
  promptSections: [PROMPT],
  toolApproval: {
    // Rewrites the ORG-WIDE user-level memory schema — one file steering
    // every memory-enabled agent's background extraction.
    // (generate_memory_schemas is deliberately un-gated: pure generation.)
    save_user_memory_schema: "user-approval",
  },
  // The whole memory-* prefix is reserved: the platform's memory system agents
  // live there and pickers hide every name matching it.
  validateSave: (_principal, record) =>
    record.name.startsWith("memory-")
      ? `"${record.name}" is reserved (memory-* are platform system agents) — pick another name.`
      : undefined,
  tools: async (principal) => {
    const { getLatch } = await import("@/lib/latch");
    const { memoryStore } = await getLatch();
    return {
      generate_memory_schemas: tool({
        description:
          "Draft memory index schemas (markdown '## Section' outlines) for an agent from its " +
          "instructions — one per requested level. Pure generation, nothing persists: attach the " +
          "agent-held levels via save_agent's exec.memory.schemas after the user approves " +
          "them; a 'user'-level draft is saved with save_user_memory_schema instead.",
        inputSchema: z.object({
          name: z.string().describe("The agent's name (context for the drafts)."),
          instructions: z.string().min(1).describe("The agent's system prompt to derive the schemas from."),
          levels: z
            .array(z.enum(["agent-user", "agent-org", "user"]))
            .min(1)
            .describe("Which memory levels to draft schemas for."),
        }),
        execute: async ({ name, instructions, levels }) => {
          const { buildSchemaGenerationPrompt } = await import("@/lib/memory/schema-generation");
          const { generateText } = await import("ai");
          const schemas: Record<string, string> = {};
          for (const level of Array.from(new Set(levels))) {
            const { text } = await generateText({
              model: anthropic("claude-sonnet-4-6"),
              ...buildSchemaGenerationPrompt({ agent: name, instructions, level }),
            });
            const fenced = /```(?:markdown|md)?\n([\s\S]*?)```/.exec(text);
            schemas[level] = (fenced?.[1] ?? text).trim();
          }
          return {
            schemas,
            note:
              "Show these to the user and apply their edits. Attach agent-user/agent-org via " +
              "save_agent exec.memory.schemas; save a 'user' draft with save_user_memory_schema.",
          };
        },
      }),

      save_user_memory_schema: tool({
        description:
          "Save the ORG-WIDE user-level memory schema — one shared workspace file " +
          "(__shared_root/_memory/_user/SCHEMA.md) governing what EVERY agent's background archivist files into " +
          "users' cross-agent profiles. Affects all memory-enabled agents on the connection — " +
          "pauses for the user's approval.",
        inputSchema: z.object({
          connection: z
            .string()
            .default("loredex")
            .describe("The memory connection whose workspace holds the file (default 'loredex')."),
          schema: z
            .string()
            .min(1)
            .describe("The complete schema markdown ('## Section' headings + description bullets)."),
        }),
        execute: async ({ connection, schema }) => {
          // Org-wide memory policy — admin-gated like create/delete_connection
          // (the approval pause alone still lets any member approve their own ask).
          if (!(await isOrgAdmin(principal.userId!, principal.orgId))) {
            return { error: "only an org admin can edit the shared user schema" };
          }
          if (schema.length > 4000) return { error: "schema too long (max 4000 chars)" };
          if (!isOutline(schema)) return { error: 'the schema needs at least one "## Section" heading' };
          const { USER_SCHEMA_PATH } = await import("@intentface/latch-memory");
          try {
            await memoryStore.writeFile(principal, {
              connection,
              path: USER_SCHEMA_PATH,
              content: schema.endsWith("\n") ? schema : `${schema}\n`,
              summary: "Shared user-memory index schema (all agents, user level)",
            });
            return { saved: true, path: USER_SCHEMA_PATH, connection };
          } catch (error) {
            return { error: `could not write the schema file: ${String(error)}` };
          }
        },
      }),
    };
  },
};
