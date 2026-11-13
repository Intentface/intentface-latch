import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { api } from "./api";

/*
 * The chats live here rather than in a component: a tab's content unmounts
 * when you switch away, and an answer that is still streaming has to keep
 * going while you read a file in another tab.
 */

const chats = new Map<string, Promise<Chat<UIMessage>>>();
const finished = new Set<() => void>();

/** One chat per person and chat id, its history loaded once from the server. */
export function chatFor(person: string, chatId: string): Promise<Chat<UIMessage>> {
  const key = `${person}:${chatId}`;
  let chat = chats.get(key);
  if (!chat) {
    chat = api.history(person, chatId).then(
      (messages) =>
        new Chat<UIMessage>({
          id: chatId,
          messages: messages as UIMessage[],
          transport: new DefaultChatTransport({ api: api.chatUrl(chatId), headers: api.headers(person) }),
          onFinish: () => finished.forEach((fn) => fn()),
        }),
      (e: unknown) => {
        // Not cached: opening the chat again tries again.
        chats.delete(key);
        throw e;
      },
    );
    chats.set(key, chat);
  }
  return chat;
}

/** Called after every answer: the agent may have written to the knowledge. */
export function onAnswerFinished(fn: () => void): () => void {
  finished.add(fn);
  return () => finished.delete(fn);
}
