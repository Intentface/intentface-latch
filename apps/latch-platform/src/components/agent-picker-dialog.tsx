import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/ui/dialog";

/**
 * Searchable agent picker for starting a new chat. A dropdown stops working
 * past a dozen agents; this is a palette: type to filter, ↑/↓ to move,
 * Enter to start. Rows keep the Settings-row anatomy (icon tile, label,
 * truncated description) so it reads like the rest of the app.
 */

export interface PickableAgent {
  name: string;
  title?: string;
  description?: string;
  hidden?: boolean;
}

export function AgentPickerDialog({
  agents,
  onClose,
}: {
  agents: readonly PickableAgent[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pickable = agents.filter((a) => !a.hidden);
    if (!q) return pickable;
    return pickable.filter((a) =>
      [a.title ?? "", a.name, a.description ?? ""].some((s) => s.toLowerCase().includes(q)),
    );
  }, [agents, query]);

  const start = (agent: string) => {
    setOpen(false);
    void navigate({
      to: "/chat/$chatId",
      params: { chatId: crypto.randomUUID() },
      search: { agent },
    });
    // Programmatic close never fires onOpenChange — reset the parent's state
    // too, or the palette can never be reopened.
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = visible[Math.min(active, visible.length - 1)];
      if (pick) start(pick.name);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Content className="max-w-md p-0" aria-label="Start a new chat">
        <Dialog.Title className="sr-only">Start a new chat</Dialog.Title>
        <div className="border-primary-border flex items-center gap-2 border-b px-3">
          <Search className="text-ink-tertiary size-4 shrink-0" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- a palette exists to be typed into
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search agents…"
            className="text-ink-primary placeholder:text-ink-tertiary h-11 w-full bg-transparent text-sm outline-none"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {visible.length === 0 ? (
            <p className="text-ink-tertiary px-3 py-6 text-center text-sm">
              No agents match “{query}”.
            </p>
          ) : (
            visible.map((a, i) => (
              <button
                key={a.name}
                type="button"
                onClick={() => start(a.name)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-md p-2 text-left outline-none",
                  i === active && "bg-primary-bg-hover",
                )}
              >
                <span className="bg-tertiary-bg text-ink-secondary flex size-8 shrink-0 items-center justify-center rounded-md">
                  <Bot className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ink-primary truncate text-sm font-medium">
                    {a.title ?? a.name}
                  </span>
                  {a.description ? (
                    <span className="text-ink-tertiary truncate text-xs">{a.description}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </Dialog.Content>
    </Dialog>
  );
}
