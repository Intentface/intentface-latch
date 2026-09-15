"use client";

import { useState } from "react";
import { MessageSquare, Wallet, Plus, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { ChatView } from "@/components/chat-view";
import { SpendView } from "@/components/spend-view";

export interface LabPrincipal {
  orgId: string;
  userId: string;
}

const newChatId = () => `c_${Math.random().toString(36).slice(2, 10)}`;

const TABS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "spend", label: "Spend", icon: Wallet },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function Console({
  principal,
  email,
  name,
  chats,
  limits,
}: {
  principal: LabPrincipal;
  email: string;
  name: string;
  chats: Array<{ id: string; updatedAt: number }>;
  limits: { org: number; user: number };
}) {
  const [tab, setTab] = useState<TabId>("chat");
  const [chatId, setChatId] = useState(() => chats[0]?.id ?? newChatId());
  const [known, setKnown] = useState(chats);

  const orgLabel = principal.orgId.startsWith("user:") ? "Personal" : principal.orgId;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r border-secondary-border bg-secondary-bg">
        <div className="px-4 py-3">
          <div className="text-sm font-medium tracking-tight">Agent Lab</div>
          <div className="truncate text-2xs text-ink-tertiary" title={principal.orgId}>
            {orgLabel}
          </div>
        </div>

        <nav className="flex gap-1 px-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
                tab === id
                  ? "bg-tertiary-bg text-ink-primary"
                  : "text-ink-tertiary hover:bg-secondary-bg-hover hover:text-ink-secondary",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </nav>

        {tab === "chat" && (
          <>
            <button
              onClick={() => setChatId(newChatId())}
              className="mx-2 mt-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-secondary-bg-hover"
            >
              <Plus className="size-3.5" />
              New conversation
            </button>
            <ul className="mt-1 flex-1 overflow-y-auto px-2 pb-2">
              {known.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setChatId(c.id)}
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      c.id === chatId
                        ? "bg-tertiary-bg text-ink-primary"
                        : "text-ink-tertiary hover:bg-secondary-bg-hover",
                    )}
                  >
                    {c.id}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-auto border-t border-secondary-border px-3 py-2.5">
          <div className="truncate text-2xs text-ink-secondary">{name || email}</div>
          <button
            onClick={() => void signOut().then(() => window.location.reload())}
            className="mt-1 flex items-center gap-1 text-2xs text-ink-tertiary transition-colors hover:text-ink-secondary"
          >
            <LogOut className="size-3" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {tab === "chat" ? (
          <ChatView
            key={chatId}
            chatId={chatId}
            onTurnEnd={() =>
              setKnown((k) =>
                k.some((c) => c.id === chatId)
                  ? k
                  : [{ id: chatId, updatedAt: Date.now() }, ...k],
              )
            }
          />
        ) : (
          <SpendView limits={limits} />
        )}
      </main>
    </div>
  );
}
