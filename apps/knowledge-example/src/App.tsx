import { useCallback, useEffect, useState } from "react";
import { api, type Person } from "./api";
import { Chat } from "./Chat";
import { FileViewer } from "./FileViewer";
import { KnowledgeTree } from "./KnowledgeTree";
import { PeoplePicker } from "./PeoplePicker";

const newChatId = () => `chat_${crypto.randomUUID().slice(0, 8)}`;

/** Each person keeps their own current chat across reloads. */
function chatIdFor(person: string): string {
  const key = `knowledge-example:chat:${person}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const id = newChatId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return newChatId();
  }
}

export function App() {
  const [people, setPeople] = useState<Person[]>([]);
  const [personId, setPersonId] = useState("maija");
  const [chatId, setChatId] = useState(() => chatIdFor("maija"));
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Bumped after each answer: the agent may have written to the knowledge.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    api.people().then(setPeople, () => setPeople([]));
  }, []);

  const person = people.find((p) => p.id === personId);

  const switchTo = (id: string) => {
    setPersonId(id);
    setChatId(chatIdFor(id));
    setOpenPath(null);
  };

  const startNewChat = () => {
    const id = newChatId();
    try {
      localStorage.setItem(`knowledge-example:chat:${personId}`, id);
    } catch {
      // A new chat still works; it just isn't remembered.
    }
    setChatId(id);
  };

  const onTurnFinished = useCallback(() => setRevision((r) => r + 1), []);

  return (
    <div className="app" data-viewer={openPath ? "open" : "closed"}>
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-name">Advisor</span>
          <span className="brand-sub">Latch knowledge example</span>
        </header>
        <PeoplePicker people={people} selected={personId} onSelect={switchTo} />
        {person && <KnowledgeTree person={person} revision={revision} openPath={openPath} onOpen={setOpenPath} />}
      </aside>

      <main className="main">
        {person ? (
          <Chat
            key={`${personId}:${chatId}`}
            person={person}
            chatId={chatId}
            onNewChat={startNewChat}
            onOpenFile={setOpenPath}
            onTurnFinished={onTurnFinished}
          />
        ) : (
          <p className="loading">Loading…</p>
        )}
      </main>

      {openPath && person && <FileViewer person={person} path={openPath} revision={revision} onClose={() => setOpenPath(null)} />}
    </div>
  );
}
