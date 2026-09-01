// Maps this platform's tool names to human-readable labels for the steps UI.

/**
 * Maps tool names (the part type minus its `tool-` prefix, or a dynamic tool's
 * `toolName`) to human-readable labels. Each entry provides an active
 * (in-progress) and complete (finished) label generator that receives the
 * tool's input for dynamic text.
 *
 * A tool with no entry falls back to `Running <name>` / `Ran <name>`, so this
 * map is a nicety, not a registry — MCP and OpenAPI connection tools resolve at
 * runtime and will never all be listed here.
 */
export type ToolLabels = Record<
  string,
  {
    active: (input: Record<string, unknown>) => string
    /** `output` is only present once the call finished (parsed if it was JSON). */
    complete: (input: Record<string, unknown>, output?: unknown) => string
  }
>

/**
 * The query of a search call, wherever the provider put it. Our own tool and
 * Anthropic's native search carry `input.query`; OpenAI's native search has an
 * EMPTY input — the query only appears in the OUTPUT as `action.query` (or
 * `action.queries`); Google's grounding has no per-call query at all.
 */
const searchQuery = (
  input: Record<string, unknown>,
  output?: unknown
): string | undefined => {
  if (typeof input.query === "string" && input.query) return input.query
  const action = (
    output as { action?: { query?: unknown; queries?: unknown } } | undefined
  )?.action
  if (typeof action?.query === "string" && action.query) return action.query
  if (Array.isArray(action?.queries) && action.queries.length > 0) {
    return action.queries.filter((q) => typeof q === "string").join("', '")
  }
  return undefined
}

/** Hostname of a URL-ish input, for the fetch tools' labels. */
const host = (value: unknown): string => {
  if (typeof value !== "string" || !value) return "the web"
  try {
    return new URL(value).hostname.replace(/^www\./, "")
  } catch {
    return value
  }
}

export const DEFAULT_TOOL_LABELS: ToolLabels = {
  // Web
  web_fetch: {
    active: (i) => `Reading ${host(i.url)}`,
    complete: (i) => `Read ${host(i.url)}`,
  },
  render_fetch: {
    active: (i) => `Rendering ${host(i.url)}`,
    complete: (i) => `Rendered ${host(i.url)}`,
  },
  web_search: {
    active: (i) => {
      const q = searchQuery(i)
      return q ? `Searching for '${q}'` : "Searching the web"
    },
    complete: (i, o) => {
      const q = searchQuery(i, o)
      return q ? `Searched for '${q}'` : "Searched the web"
    },
  },

  // Memory
  remember: {
    active: () => "Saving to memory",
    complete: () => "Saved to memory",
  },
  memory_save: {
    active: () => "Saving to memory",
    complete: () => "Saved to memory",
  },
  memory_search: {
    active: (i) => `Recalling '${i.query ?? ""}'`,
    complete: (i) => `Recalled '${i.query ?? ""}'`,
  },

  // Connections + credentials
  create_connection: {
    active: (i) => `Creating the ${i.name ?? "connection"} connection`,
    complete: (i) => `Created the ${i.name ?? "connection"} connection`,
  },
  delete_connection: {
    active: (i) => `Deleting the ${i.name ?? "connection"} connection`,
    complete: (i) => `Deleted the ${i.name ?? "connection"} connection`,
  },
  connect_connection: {
    active: (i) => `Connecting ${i.name ?? "the integration"}`,
    complete: (i) => `Connected ${i.name ?? "the integration"}`,
  },
  list_connections: {
    active: () => "Listing connections",
    complete: () => "Listed connections",
  },
  list_connection_tools: {
    active: (i) => `Inspecting ${i.name ?? "connection"} tools`,
    complete: (i) => `Inspected ${i.name ?? "connection"} tools`,
  },
  list_tools: {
    active: () => "Listing available tools",
    complete: () => "Listed available tools",
  },
  list_secrets: {
    active: () => "Checking stored credentials",
    complete: () => "Checked stored credentials",
  },
  request_secret: {
    active: (i) => `Asking for ${i.title ?? "credentials"}`,
    complete: (i) => `Asked for ${i.title ?? "credentials"}`,
  },

  // Delegation + code
  spawn_agent: {
    active: (i) => `Delegating to ${i.agent ?? "an agent"}`,
    complete: (i) => `Delegated to ${i.agent ?? "an agent"}`,
  },
  bash: {
    active: (i) => `Running ${i.command ?? "a command"}`,
    complete: (i) => `Ran ${i.command ?? "a command"}`,
  },

  // Schedules
  create_schedule: {
    active: (i) => `Scheduling ${i.name ?? "a run"}`,
    complete: (i) => `Scheduled ${i.name ?? "a run"}`,
  },
  list_schedules: {
    active: () => "Reading schedules",
    complete: () => "Read schedules",
  },
  cancel_schedule: {
    active: (i) => `Cancelling ${i.name ?? "the schedule"}`,
    complete: (i) => `Cancelled ${i.name ?? "the schedule"}`,
  },
  list_delivery_channels: {
    active: () => "Checking delivery channels",
    complete: () => "Checked delivery channels",
  },

  // Agent Builder
  save_agent: {
    active: (i) => `Saving ${i.name ?? "the agent"}`,
    complete: (i) => `Saved ${i.name ?? "the agent"}`,
  },
  get_agent: {
    active: (i) => `Reading ${i.name ?? "the agent"}`,
    complete: (i) => `Read ${i.name ?? "the agent"}`,
  },
  list_agents: {
    active: () => "Listing agents",
    complete: () => "Listed agents",
  },
  delete_agent: {
    active: (i) => `Deleting ${i.name ?? "the agent"}`,
    complete: (i) => `Deleted ${i.name ?? "the agent"}`,
  },
  test_agent: {
    active: (i) => `Testing ${i.name ?? "the agent"}`,
    complete: (i) => `Tested ${i.name ?? "the agent"}`,
  },
  list_models: {
    active: () => "Listing models",
    complete: () => "Listed models",
  },
  list_chats: {
    active: () => "Reading chat history",
    complete: () => "Read chat history",
  },
  read_chat: {
    active: () => "Reading a conversation",
    complete: () => "Read a conversation",
  },

  // Evals
  save_eval_set: {
    active: (i) => `Saving eval set for ${i.agentName ?? "agent"}`,
    complete: (i) => `Saved eval set for ${i.agentName ?? "agent"}`,
  },
  list_eval_sets: {
    active: () => "Reading eval sets",
    complete: () => "Read eval sets",
  },
  run_evals: {
    active: (i) => `Running evals for ${i.agentName ?? "agent"}`,
    complete: (i) => `Ran evals for ${i.agentName ?? "agent"}`,
  },
  list_eval_runs: {
    active: () => "Reading eval history",
    complete: () => "Read eval history",
  },
}
