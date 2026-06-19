import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/chat/")({
  component: () => (
    <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
      Select a chat, or start a new one.
    </div>
  ),
});
