import { describe, expect, it } from "vitest";
import {
  CHANNEL_COMMANDS,
  helpText,
  parseCommand,
  telegramCommandMenu,
  THREAD_CHANGING_COMMANDS,
} from "./commands.js";

describe("parseCommand", () => {
  it("parses a bare command", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", args: "" });
  });

  it("ignores surrounding whitespace and case", () => {
    expect(parseCommand("  /NEW  ")).toEqual({ name: "new", args: "" });
  });

  it("resolves aliases to the canonical name", () => {
    expect(parseCommand("/reset")?.name).toBe("new");
    expect(parseCommand("/skip")?.name).toBe("cancel");
    expect(parseCommand("/commands")?.name).toBe("help");
  });

  it("strips Telegram's @botname suffix", () => {
    expect(parseCommand("/status@runner_coach_bot")).toEqual({ name: "status", args: "" });
    expect(parseCommand("/status@runner_coach_bot now")).toEqual({ name: "status", args: "now" });
  });

  it("rejects a malformed @suffix instead of reading past it", () => {
    // Otherwise anything after the `@` would be discarded and `/help@x/docs`
    // would run `/help`.
    expect(parseCommand("/help@bot/docs")).toBeNull();
    expect(parseCommand("/new@")).toBeNull();
    expect(parseCommand("/new@bot@bot")).toBeNull();
  });

  it("keeps the arguments", () => {
    expect(parseCommand("/compact  keep the training plan  ")).toEqual({
      name: "compact",
      args: "keep the training plan",
    });
  });

  it("keeps multi-line arguments", () => {
    expect(parseCommand("/compact one\ntwo")).toEqual({ name: "compact", args: "one\ntwo" });
  });

  it("is not a command when the name is unknown", () => {
    // Unknown commands must reach the agent unchanged, not be swallowed.
    expect(parseCommand("/foobar")).toBeNull();
    expect(parseCommand("/deploy now")).toBeNull();
  });

  it("is not a command when it's a pasted path", () => {
    // `/new/plan.md` shares a first segment with a real command — it must not parse.
    expect(parseCommand("/new/plan.md")).toBeNull();
    expect(parseCommand("/Users/me/notes.txt")).toBeNull();
    expect(parseCommand("/etc/hosts")).toBeNull();
  });

  it("is not a command when there's no leading slash", () => {
    expect(parseCommand("new")).toBeNull();
    expect(parseCommand("please /new")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/")).toBeNull();
  });
});

describe("the registry", () => {
  it("lists every command in /help", () => {
    const text = helpText();
    for (const c of CHANNEL_COMMANDS) expect(text).toContain(`/${c.name} — ${c.description}`);
  });

  it("offers canonical names (not aliases) to Telegram's menu", () => {
    const menu = telegramCommandMenu();
    expect(menu.map((m) => m.command)).toEqual(CHANNEL_COMMANDS.map((c) => c.name));
    // Telegram rejects command names outside [a-z0-9_], 1-32 chars.
    for (const m of menu) expect(m.command).toMatch(/^[a-z0-9_]{1,32}$/);
    for (const m of menu) expect(m.description.length).toBeLessThanOrEqual(256);
  });

  it("marks only the thread-changing commands as such", () => {
    for (const name of THREAD_CHANGING_COMMANDS) {
      expect(CHANNEL_COMMANDS.some((c) => c.name === name)).toBe(true);
    }
    expect(THREAD_CHANGING_COMMANDS.has("status")).toBe(false);
    expect(THREAD_CHANGING_COMMANDS.has("help")).toBe(false);
    expect(THREAD_CHANGING_COMMANDS.has("start")).toBe(false);
  });
});
