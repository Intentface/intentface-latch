import type { Canvas } from "./canvas.js";
import { lineDiff } from "./canvas.js";
import type { ChannelState, StateStore } from "./state.js";

/**
 * StateStore whose DOCUMENT lives in the channel canvas. Everyone in the
 * channel can read what the agent believes and fix it in place; the agent
 * picks the edit up on its next tick and is told what changed.
 *
 * The SQLite store underneath keeps what nobody should edit — the read cursor,
 * the post log — and a SHADOW of the document as the agent last wrote it. The
 * shadow is what makes human edits visible (canvas vs shadow at load), and it
 * is the fallback when the canvas cannot be read.
 */
export function createCanvasStateStore(input: {
  base: StateStore;
  canvas: Canvas;
  /** Markdown for a canvas created on first contact. */
  initial: string;
  onError?: (channel: string, e: unknown) => void;
  /** A canvas was resolved for a channel (once per channel per database). */
  onCanvas?: (channel: string, id: string, how: "existing" | "created" | "found-after-conflict") => void;
}): StateStore {
  const { base, canvas } = input;
  const ids = new Map<string, string>();

  /** Persisted per channel so a restart reuses the same canvas instead of creating another. */
  const canvasId = async (channel: string): Promise<string> => {
    const hit = ids.get(channel) ?? (await base.getCanvasId(channel));
    if (hit) {
      ids.set(channel, hit);
      return hit;
    }
    const { id, how } = await canvas.ensure(channel, input.initial);
    input.onCanvas?.(channel, id, how);
    await base.setCanvasId(channel, id);
    ids.set(channel, id);
    return id;
  };

  return {
    migrate: () => base.migrate(),
    markBootstrapped: (c) => base.markBootstrapped(c),
    recordPost: (c, ts, k, t) => base.recordPost(c, ts, k, t),
    unpromptedPostsSince: (c, s) => base.unpromptedPostsSince(c, s),
    recentPosts: (c, s) => base.recentPosts(c, s),
    monologueGen: (c) => base.monologueGen(c),
    newMonologue: (c) => base.newMonologue(c),
    getCanvasId: (c) => base.getCanvasId(c),
    setCanvasId: (c, id) => base.setCanvasId(c, id),
    push: (c, k, o) => base.push(c, k, o),
    drain: (c) => base.drain(c),
    peek: (c) => base.peek(c),
    pending: (c) => base.pending(c),
    logTriage: (c, v) => base.logTriage(c, v),
    listTriage: (c, n) => base.listTriage(c, n),

    async load(channel): Promise<ChannelState> {
      const shadow = await base.load(channel);
      try {
        const doc = await canvas.read(await canvasId(channel));
        const { added, removed } = lineDiff(shadow.doc, doc);
        const edited = shadow.doc.trim() !== "" && (added.length > 0 || removed.length > 0);
        return { ...shadow, doc, ...(edited ? { humanEdits: { added, removed } } : {}) };
      } catch (e) {
        input.onError?.(channel, e);
        return shadow; // the last version the agent wrote
      }
    },

    async saveDoc(channel, doc) {
      await canvas.replace(await canvasId(channel), doc);
      await base.saveDoc(channel, doc);
    },
  };
}
