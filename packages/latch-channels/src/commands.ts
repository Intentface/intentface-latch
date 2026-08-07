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
  // The command word matches Telegram's own grammar exactly — `[A-Za-z0-9_]`
  // plus an optional `@botusername` — and nothing else. Anything with another
  // character in it (`/new/plan.md`, `/Users/me/notes.txt`, `/help@bot/docs`)
  // fails to match and stays an ordinary message, so a pasted path is never
  // mistaken for the command its first segment happens to spell.
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = BY_NAME.get(m[1]!.toLowerCase());
  if (!name) return null;
  return { name, args: (m[3] ?? "").trim() };
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
