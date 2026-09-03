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
}): StateStore {
  const { base, canvas } = input;
  const ids = new Map<string, string>();

  const canvasId = async (channel: string): Promise<string> => {
    const hit = ids.get(channel);
    if (hit) return hit;
    const id = await canvas.ensure(channel, input.initial);
    ids.set(channel, id);
    return id;
  };

  return {
    migrate: () => base.migrate(),
    advanceCursor: (c, ts) => base.advanceCursor(c, ts),
    recordPost: (c, ts, k) => base.recordPost(c, ts, k),
    unpromptedPostsSince: (c, s) => base.unpromptedPostsSince(c, s),
    addMention: (c, m) => base.addMention(c, m),
    takeMentions: (c) => base.takeMentions(c),

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
