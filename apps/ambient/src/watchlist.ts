/**
 * Which channels to watch = which channels the bot is a member of. `/invite`
 * starts watching, `/kick` stops; no config list to keep in sync. Refreshed at
 * boot, on an interval, and whenever a mention arrives from a channel we have
 * not seen (we are evidently in it).
 */
export interface Watchlist {
  has(channel: string): boolean;
  ids(): string[];
  /** Re-list membership and reconcile; serialized so overlapping calls share one pass. */
  refresh(): Promise<void>;
}

export function createWatchlist(deps: {
  list: () => Promise<{ id: string; name: string }[]>;
  onAdd: (channel: { id: string; name: string }) => Promise<void>;
  onRemove: (channel: string) => Promise<void>;
  onError?: (e: unknown) => void;
}): Watchlist {
  const watched = new Map<string, string>();
  let inflight: Promise<void> | undefined;

  async function reconcile(): Promise<void> {
    const current = await deps.list();
    const seen = new Set<string>();
    for (const ch of current) {
      seen.add(ch.id);
      if (!watched.has(ch.id)) {
        await deps.onAdd(ch);
        watched.set(ch.id, ch.name);
      }
    }
    for (const id of [...watched.keys()]) {
      if (!seen.has(id)) {
        await deps.onRemove(id);
        watched.delete(id);
      }
    }
  }

  return {
    has: (c) => watched.has(c),
    ids: () => [...watched.keys()],
    refresh() {
      inflight ??= reconcile()
        .catch((e) => deps.onError?.(e))
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
