import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import type { AppMessage } from "@intentface/latch-core";
import { loadHistoryFn } from "@/lib/server";
import { Chat } from "@/components/chat";

export const Route = createFileRoute("/chat/$chatId")({
  // `?agent=<name>` carries the picked agent for a brand-new chat (existing
  // chats resolve their agent from the persisted record instead).
  validateSearch: (search: Record<string, unknown>) => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  loader: ({ params }) => loadHistoryFn({ data: params.chatId }),
  component: ChatPage,
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const { agent: searchAgent } = Route.useSearch();
  const initialMessages = Route.useLoaderData() as AppMessage[];
  // The chat's agent: the persisted one (existing chats) wins; for a new chat
  // use the picked `?agent`; fall back to the first registered agent.
  const { chats, agents } = useLoaderData({ from: "/chat" });
  const agent =
    chats.find((c) => c.id === chatId)?.agent ??
    searchAgent ??
    agents[0]?.name ??
    "assistant";

  // key by chatId so useChat resets when switching chats
  return (
    <Chat key={chatId} chatId={chatId} agent={agent} initialMessages={initialMessages} />
  );
}
