import { createFileRoute } from "@tanstack/react-router";
import type { AppMessage } from "@intentface/latch-core";
import { loadHistoryFn } from "@/lib/server";
import { Chat } from "@/components/chat";

export const Route = createFileRoute("/chat/$chatId")({
  loader: ({ params }) => loadHistoryFn({ data: params.chatId }),
  component: ChatPage,
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const initialMessages = Route.useLoaderData() as AppMessage[];
  // key by chatId so useChat resets when switching chats
  return <Chat key={chatId} chatId={chatId} initialMessages={initialMessages} />;
}
