import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { currentPrincipalFn, listChatsFn, listAgentsFn } from "@/lib/server";

export const Route = createFileRoute("/chat")({
  // Server-side auth gate (sees the cookie during SSR, unlike the client hook).
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  // The threads list (index) and the per-chat view both read this; the global
  // app sidebar carries navigation, so the layout is just the auth gate + outlet.
  loader: async () => {
    const [chats, agents] = await Promise.all([listChatsFn(), listAgentsFn()]);
    return { chats, agents };
  },
  component: () => (
    <div className="h-full min-w-0">
      <Outlet />
    </div>
  ),
});
