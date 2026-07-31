/**
 * Chat-surface commands — pure parsing plus the one registry every surface reads,
 * so `/help`, Telegram's native command menu and the dispatcher can never list
 * different things.
 *
 * Only KNOWN commands parse. Unknown `/`-prefixed text is not a command and must
 * keep reaching the agent as an ordinary message: people paste `/Users/me/notes`
 * and `/etc/hosts` into chats, and swallowing those would lose real input.
 */

export interface ChannelCommand {
  /** Canonical name, without the leading slash. */
  name: string;
  /** Alternative spellings that resolve to `name`. */
  aliases?: string[];
  /** One line, shown in `/help` and in Telegram's command menu. */
  description: string;
}

export const CHANNEL_COMMANDS: ChannelCommand[] = [
  { name: "new", aliases: ["reset"], description: "Start a fresh conversation" },
  { name: "compact", description: "Summarize this conversation to free up context" },
  {
    name: "cancel",
    aliases: ["skip"],
    description: "Cancel whatever the agent is waiting on",
  },
  { name: "status", description: "Show what this conversation is doing" },
  { name: "help", aliases: ["commands"], description: "List the available commands" },
  { name: "start", description: "What this bot can do" },
];

/** Commands that end or replace the current thread, so a live questionnaire dies with them. */
export const THREAD_CHANGING_COMMANDS = new Set(["new", "compact", "cancel"]);

export interface ParsedCommand {
  /** Canonical command name (aliases already resolved). */
  name: string;
  /** Everything after the command word, trimmed (empty when there was none). */
  args: string;
}

/** name/alias (lowercased) → canonical name. */
const BY_NAME = new Map<string, string>(
  CHANNEL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c.name] as const)),
);

/**
 * Parse a message as a command, or null if it isn't one.
 *
 * Telegram appends `@botusername` when a command is typed in a group and can
 * carry arguments; both are handled here so channels don't each re-derive it.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  // `\S+` deliberately: `/foo/bar` must NOT parse as `/foo` with args, or a
  // pasted path whose first segment happens to be a command name gets eaten.
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  // Strip Telegram's `@botname` suffix, but only from the command word.
  const bare = word.includes("@") ? word.slice(0, word.indexOf("@")) : word;
  const name = BY_NAME.get(bare);
  if (!name) return null;
  return { name, args: (m[2] ?? "").trim() };
}

/** The `/help` body: one `/command — description` line per command. */
export function helpText(commands: ChannelCommand[] = CHANNEL_COMMANDS): string {
  return commands.map((c) => `/${c.name} — ${c.description}`).join("\n");
}

/** Telegram `setMyCommands` payload — canonical names only (aliases stay hidden). */
export function telegramCommandMenu(
  commands: ChannelCommand[] = CHANNEL_COMMANDS,
): { command: string; description: string }[] {
  return commands.map((c) => ({ command: c.name, description: c.description }));
}
