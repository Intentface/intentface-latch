/**
 * Live streams: an answer's stream, readable by a request other than the one
 * that started it. A page that reloads mid-answer, a second viewer, or a page
 * whose chat got an answer nobody asked for from that page (a held message, a
 * signal, a schedule) reads the answer as it is written.
 *
 * Optional. Without `liveStreams` on the runtime, such a page polls
 * (`pollChat`) and sees the answer once it is saved.
 *
 * The store is where the stream is kept while the answer runs. On one
 * long-running server, memory is enough (`memoryLiveStreams`). On a
 * serverless host the reader lands on another instance than the writer, so
 * the store has to be shared: Redis pub/sub through the `resumable-stream`
 * package fits this interface as it is.
 */
export interface LiveStreams {
  /**
   * Keep `stream` readable under `streamId` until it ends. Called once per
   * id, when the answer starts. Must read `stream` to its end whether or not
   * anybody subscribes.
   */
  publish(streamId: string, stream: ReadableStream<string>): Promise<void>;
  /**
   * The stream from its start, then live. `null` when it has ended or was
   * never published (the answer is in the history, or will be).
   */
  subscribe(streamId: string): Promise<ReadableStream<string> | null>;
  /**
   * Optional, with `listen`: send `message` to whoever listens on `channel`
   * right now. Nothing is kept for a later listener. With both, a page can
   * hold one connection per chat and be told when an answer starts
   * (`watchChat`) instead of polling.
   */
  notify?(channel: string, message: string): Promise<void>;
  /** What is sent to `channel` from now on. Cancel the stream to stop. */
  listen?(channel: string): Promise<ReadableStream<string>>;
}

/** What a page watching a chat is told (`watchChat`). */
export type ChatEvent =
  /** First on every connection: whether an answer is running right now. */
  | { type: "hello"; running: boolean }
  /** An answer started: read it with `streamChat`. */
  | { type: "started" }
  /** That answer ended and is saved. */
  | { type: "ended" }
  /** Something else changed (a signal was stored, an input held or taken back): read `pollChat`. */
  | { type: "changed" };

/**
 * Live streams kept in this process. For one long-running server, and tests.
 * A stream is dropped when it ends.
 */
export function memoryLiveStreams(): LiveStreams {
  const live = new Map<string, { chunks: string[]; readers: Set<ReadableStreamDefaultController<string>> }>();
  const listeners = new Map<string, Set<ReadableStreamDefaultController<string>>>();
  return {
    async notify(channel, message) {
      for (const to of listeners.get(channel) ?? []) {
        try {
          to.enqueue(message);
        } catch {
          listeners.get(channel)?.delete(to);
        }
      }
    },
    async listen(channel) {
      let mine: ReadableStreamDefaultController<string> | undefined;
      const drop = () => {
        const set = listeners.get(channel);
        if (mine) set?.delete(mine);
        if (set?.size === 0) listeners.delete(channel);
      };
      return new ReadableStream<string>({
        start(controller) {
          mine = controller;
          if (!listeners.has(channel)) listeners.set(channel, new Set());
          listeners.get(channel)!.add(controller);
        },
        cancel: drop,
      });
    },
    async publish(streamId, stream) {
      const entry = { chunks: [] as string[], readers: new Set<ReadableStreamDefaultController<string>>() };
      live.set(streamId, entry);
      const close = () => {
        if (live.get(streamId) === entry) live.delete(streamId);
        for (const reader of entry.readers) {
          try {
            reader.close();
          } catch {
            // Its reader left already.
          }
        }
        entry.readers.clear();
      };
      void (async () => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.chunks.push(value);
            for (const to of entry.readers) {
              try {
                to.enqueue(value);
              } catch {
                entry.readers.delete(to);
              }
            }
          }
        } catch {
          // The answer's own stream failed; its readers end with it.
        } finally {
          close();
        }
      })();
    },
    async subscribe(streamId) {
      const entry = live.get(streamId);
      if (!entry) return null;
      let mine: ReadableStreamDefaultController<string> | undefined;
      return new ReadableStream<string>({
        start(controller) {
          mine = controller;
          for (const chunk of entry.chunks) controller.enqueue(chunk);
          entry.readers.add(controller);
        },
        cancel() {
          if (mine) entry.readers.delete(mine);
        },
      });
    },
  };
}
