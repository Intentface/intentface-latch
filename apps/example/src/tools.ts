import { tool, type Tool } from "ai";
import { z } from "zod";

/**
 * A real, dependency-free tool: the current time. The model cannot know this on
 * its own, so asking "what time is it in Tokyo?" forces a genuine tool call —
 * a clean way to see the tool-call → tool-result → final-answer loop end to end.
 */
export const getCurrentTime: Tool = tool({
  description:
    "Get the current date and time, optionally in a specific IANA time zone (e.g. 'Asia/Tokyo', 'Europe/Helsinki').",
  inputSchema: z.object({
    timeZone: z
      .string()
      .optional()
      .describe("IANA time zone such as 'Asia/Tokyo'. Defaults to UTC."),
  }),
  execute: async ({ timeZone }) => {
    const now = new Date();
    const zone = timeZone ?? "UTC";
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: zone,
    }).format(now);
    return { iso: now.toISOString(), timeZone: zone, formatted };
  },
});

export const tools: Record<string, Tool> = { getCurrentTime };
