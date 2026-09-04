import TurndownService from "turndown";

/**
 * The channel canvas as a document store. Slack's canvas API is write-shaped
 * (`canvases.edit`, `canvases.sections.lookup`); the READ is the undocumented
 * but stable path every working client uses: `files.info` on the canvas id →
 * `url_private_download` → the canvas as HTML, fetched with the same bearer
 * token → markdown. Needs `canvases:read`, `canvases:write`, `files:read`, and
 * the bot must be a member of the channel.
 */
export interface Canvas {
  /**
   * The channel's canvas id: the channel canvas from `conversations.info` if it
   * has one, else created with `initial` markdown. `how` says which path was
   * taken so a workspace that keeps creating canvases can be diagnosed.
   */
  ensure(channel: string, initial: string): Promise<{ id: string; how: "existing" | "created" | "found-after-conflict" }>;
  /** The whole canvas as markdown (via the HTML download). */
  read(canvasId: string): Promise<string>;
  /** Replace the whole canvas with `markdown`. */
  replace(canvasId: string, markdown: string): Promise<void>;
}

interface SlackJson extends Record<string, unknown> {
  ok?: boolean;
  error?: string;
}

export function createCanvas(token: string, fetchImpl: typeof fetch = fetch): Canvas {
  const auth = { authorization: `Bearer ${token}` };

  async function api(method: string, body: Record<string, unknown>): Promise<SlackJson> {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as SlackJson;
    if (!json.ok) throw new Error(`slack:${method} failed: ${json.error ?? res.status}`);
    return json;
  }

  async function get(method: string, params: Record<string, string>): Promise<SlackJson> {
    const res = await fetchImpl(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: auth });
    const json = (await res.json()) as SlackJson;
    if (!json.ok) throw new Error(`slack:${method} failed: ${json.error ?? res.status}`);
    return json;
  }

  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  turndown.remove(["script", "style", "meta", "link"]);

  return {
    async ensure(channel, initial) {
      const lookup = async (): Promise<string | undefined> => {
        const info = await get("conversations.info", { channel });
        const ch = info.channel as { properties?: { canvas?: { file_id?: string; id?: string } } } | undefined;
        return ch?.properties?.canvas?.file_id ?? ch?.properties?.canvas?.id;
      };
      const existing = await lookup();
      if (existing) return { id: existing, how: "existing" };
      try {
        const created = await api("conversations.canvases.create", {
          channel_id: channel,
          document_content: { type: "markdown", markdown: initial },
        });
        const id = created.canvas_id as string | undefined;
        if (!id) throw new Error("slack:conversations.canvases.create returned no canvas_id");
        return { id, how: "created" };
      } catch (e) {
        // The channel already has a canvas we could not see a moment ago (eventual consistency,
        // or a workspace that hides it from conversations.info): look once more before giving up.
        if (!/already/i.test(String(e))) throw e;
        const again = await lookup();
        if (!again) throw e;
        return { id: again, how: "found-after-conflict" };
      }
    },

    async read(canvasId) {
      const info = await get("files.info", { file: canvasId });
      const file = info.file as { url_private_download?: string; url_private?: string } | undefined;
      const url = file?.url_private_download ?? file?.url_private;
      if (!url) throw new Error(`slack: canvas ${canvasId} has no download url`);
      const res = await fetchImpl(url, { headers: auth });
      if (!res.ok) throw new Error(`slack: canvas download failed: ${res.status}`);
      return canvasHtmlToMarkdown(await res.text(), turndown);
    },

    async replace(canvasId, markdown) {
      await api("canvases.edit", {
        canvas_id: canvasId,
        changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
      });
    },
  };
}

/** Canvas HTML → tidy markdown: zero-width joiners out, at most one blank line between blocks. */
export function canvasHtmlToMarkdown(html: string, service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" })): string {
  return service
    .turndown(html)
    .replace(/​/g, "")
    // Turndown pads list markers to four columns ("-   item"); the schema is one item per line.
    .replace(/^(\s*[-*])\s{2,}/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Line diff of two documents, for telling the agent what a human changed since
 * it last wrote. Not a real diff — added and removed lines, order kept — but
 * that is exactly the granularity the schema (one item per line) has.
 */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const a = norm(before);
  const b = norm(after);
  const inA = new Set(a);
  const inB = new Set(b);
  return { added: b.filter((l) => !inA.has(l)), removed: a.filter((l) => !inB.has(l)) };
}
