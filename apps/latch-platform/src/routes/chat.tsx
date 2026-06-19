import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { currentPrincipalFn, listChatsFn } from "@/lib/chats.server";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/chat")({
  // Server-side auth gate (sees the cookie during SSR, unlike the client hook).
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: () => listChatsFn(),
  component: ChatLayout,
});

function ChatLayout() {
  const chats = Route.useLoaderData();
  const navigate = useNavigate();

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="p-2">
          <Button
            className="w-full justify-start"
            size="sm"
            onClick={() =>
              navigate({ to: "/chat/$chatId", params: { chatId: crypto.randomUUID() } })
            }
          >
            <Plus className="size-4" /> New chat
          </Button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {chats.length === 0 && (
            <p className="text-muted-foreground px-2 py-1 text-xs">No chats yet.</p>
          )}
          {chats.map((c) => (
            <Link
              key={c.id}
              to="/chat/$chatId"
              params={{ chatId: c.id }}
              className="block truncate rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              {c.title ?? "Untitled chat"}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
