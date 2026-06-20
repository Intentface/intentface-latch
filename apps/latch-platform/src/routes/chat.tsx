import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { currentPrincipalFn, listChatsFn, listAgentsFn } from "@/lib/server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/chat")({
  // Server-side auth gate (sees the cookie during SSR, unlike the client hook).
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: async () => {
    const [chats, agents] = await Promise.all([listChatsFn(), listAgentsFn()]);
    return { chats, agents };
  },
  component: ChatLayout,
});

function ChatLayout() {
  const { chats, agents } = Route.useLoaderData();
  const navigate = useNavigate();

  const newChat = (agent: string) =>
    navigate({
      to: "/chat/$chatId",
      params: { chatId: crypto.randomUUID() },
      search: { agent },
    });

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="p-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button className="w-full justify-start gap-1" size="sm" />}
            >
              <Plus className="size-4" /> New chat
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              {agents.map((a) => (
                <DropdownMenuItem key={a.name} onClick={() => newChat(a.name)}>
                  <div className="flex flex-col">
                    <span className="text-sm">{a.title ?? a.name}</span>
                    {a.description && (
                      <span className="text-muted-foreground text-xs">{a.description}</span>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
              search={{ agent: undefined }}
              className="block rounded-md px-2 py-1.5 hover:bg-muted"
              activeProps={{ className: "bg-muted font-medium" }}
            >
              <div className="truncate text-sm">{c.title ?? "Untitled chat"}</div>
              <div className="text-muted-foreground truncate text-xs">{c.agent}</div>
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
