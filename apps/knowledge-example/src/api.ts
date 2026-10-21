import type { Person } from "../server/people";

export type { Person };

export interface Entry {
  path: string;
  type: "file" | "folder";
  size?: number;
  version?: number;
  trusted?: boolean;
  description?: string;
}

export interface FileView {
  path: string;
  version: number;
  trusted: boolean;
  lines: string[];
  updatedBy: string;
  updatedAt: string;
}

const as = (person: string) => ({ "x-demo-person": person });

async function get<T>(url: string, person?: string): Promise<T> {
  const res = await fetch(url, { headers: person ? as(person) : {} });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  people: () => get<Person[]>("/api/people"),
  tree: (person: string) => get<{ mount: string; entries: Entry[] }[]>("/api/kb/tree", person),
  file: (person: string, path: string) => get<FileView>(`/api/kb/file?path=${encodeURIComponent(path)}`, person),
  history: async (person: string, chatId: string) => {
    const res = await fetch(`/api/latch/chats/${chatId}`, { headers: as(person) });
    return res.ok ? ((await res.json()) as { messages: unknown[] }).messages : [];
  },
  chatUrl: (chatId: string) => `/api/latch/agents/advisor/${chatId}`,
  headers: as,
};
