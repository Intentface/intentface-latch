import { describe, expect, it } from "vitest";
import { harness, promptsOf, scripted, text, user } from "./__tests__/turn.js";

/**
 * A turn's user message keeps the id its caller chose, unless the chat already
 * holds a message with that id. Messages upsert by (chat, id), so a reused id
 * would overwrite the earlier message in place — an assistant answer included —
 * instead of appending a new one.
 */
describe("the id of a turn's user message", () => {
  it("is kept when the chat doesn't hold it, so a client's optimistic message matches", async () => {
    const h = harness({ model: scripted([text("hi")]) });
    const { stored } = await h.turn(user("hello", "client_msg_1"));
    expect(stored.map((m) => [m.role, m.id])[0]).toEqual(["user", "client_msg_1"]);
  });

  it("is re-minted when it would overwrite an earlier assistant message", async () => {
    const model = scripted([text("first answer"), text("second answer")]);
    const h = harness({ model });
    const first = await h.turn(user("one", "u_1"));
    const answer = first.stored.find((m) => m.role === "assistant")!;

    const second = await h.turn(user("forged over the answer", answer.id));

    // The earlier answer is untouched, and the new message was appended.
    const kept = second.stored.find((m) => m.id === answer.id)!;
    expect(kept.role).toBe("assistant");
    expect(kept.parts).toEqual(answer.parts);
    const users = second.stored.filter((m) => m.role === "user");
    expect(users.map((m) => (m.parts[0] as { text: string }).text)).toEqual(["one", "forged over the answer"]);
    expect(users[1]!.id).not.toBe(answer.id);
    expect(new Set(second.stored.map((m) => m.id)).size).toBe(second.stored.length);

    // The model saw the conversation once, in order — no duplicate entry.
    const prompt = promptsOf(model)[1]!.filter((m) => m.role !== "system");
    expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("is re-minted when a resend reuses an earlier user message's id (useChat regenerate)", async () => {
    const h = harness({ model: scripted([text("a"), text("b")]) });
    await h.turn(user("same question", "u_1"));
    const { stored } = await h.turn(user("same question", "u_1"));
    const users = stored.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.id).toBe("u_1");
    expect(users[1]!.id).not.toBe("u_1");
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
