import type { AppMessage, AppMetadata } from "@intentface/latch-core";

/**
 * The user message a `POST agents/:agent/:id` body asks to send.
 *
 * Three body shapes are accepted, in this order:
 *  - `{ message }` — one `UIMessage` (a custom transport's explicit send);
 *  - `{ text }` — a plain string;
 *  - `{ messages }` — the AI SDK `useChat` / `DefaultChatTransport` default,
 *    the whole client-side conversation; only its LAST message is new.
 *
 * Whatever the shape, the body is a request from the user, not a message to
 * store verbatim. The stored history is what the model is later fed as genuine
 * assistant and tool output, so only what a user may author survives:
 *  - `role` is always `"user"` — a client can't post an assistant prefill;
 *  - `metadata` is the server's (`visibility: "user"`, `createdAt`): the
 *    projection axes (`visibility`, `sendToModel`) and the execution facts
 *    (`model`, `usage`, `cost`, …) are never the client's to set. `voice` is
 *    the one client field kept — it marks text the user dictated and only
 *    changes how the message renders;
 *  - parts are restricted to {@link userParts}; anything else is dropped;
 *  - the client's `id` is kept when well-formed, so the client's optimistic
 *    message and the stored one share an id. The runtime re-mints it if the
 *    chat already holds a message with that id (see `handleChat`).
 */
export function toUserMessage(body: Record<string, unknown>): AppMessage {
  const source = pickSource(body);
  const parts = source.parts.length > 0 ? source.parts : [{ type: "text" as const, text: "" }];
  const voice = voiceOf(source.metadata);
  return {
    id: isUsableId(source.id) ? source.id : crypto.randomUUID(),
    role: "user",
    parts,
    metadata: { visibility: "user", createdAt: Date.now(), ...(voice ? { voice } : {}) },
  };
}

interface Source {
  id?: unknown;
  parts: AppMessage["parts"];
  metadata?: unknown;
}

function pickSource(body: Record<string, unknown>): Source {
  const explicit = asRecord(body.message);
  if (explicit && Array.isArray(explicit.parts)) {
    return { id: explicit.id, parts: userParts(explicit.parts), metadata: explicit.metadata };
  }
  if (typeof body.text === "string") return { parts: [{ type: "text", text: body.text }] };
  if (Array.isArray(body.messages)) {
    // The last message is the new one. Its claimed role is not consulted: the
    // result is a user message either way, as it always has been.
    const last = asRecord(body.messages[body.messages.length - 1]);
    if (last) return { id: last.id, parts: userParts(last.parts), metadata: last.metadata };
  }
  return { parts: [] };
}

/**
 * The parts a user may author: `text` and `file`, rebuilt from their known
 * fields. Everything else is dropped, not rejected — a stock `useChat` client
 * can carry parts it never authored (a regenerate resends the conversation),
 * and failing the whole send over one of them would break it.
 *
 * Why not more:
 *  - tool parts, `reasoning`, `source-*`, `step-start` are assistant output;
 *    stored on a user message they are fed back to the model as if real.
 *  - `data-*` parts carry runtime meaning regardless of role: a
 *    `data-compaction` part anywhere cuts the model's context window at that
 *    message, and `data-subagent-approval` is read as a pending decision. The
 *    model never sees data parts anyway (`convertToModelMessages` drops them),
 *    so a host's per-request extras belong in the body, which reaches
 *    `context.build` as `turnContext`.
 *  - `providerMetadata` becomes provider options on the model call (e.g. an
 *    Anthropic `cacheControl` breakpoint, which counts against the provider's
 *    cap alongside the ones prompt caching places). That is the agent's call.
 */
function userParts(raw: unknown): AppMessage["parts"] {
  if (!Array.isArray(raw)) return [];
  const parts: AppMessage["parts"] = [];
  for (const item of raw) {
    const p = asRecord(item);
    if (!p) continue;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "file" && typeof p.mediaType === "string" && typeof p.url === "string") {
      parts.push({
        type: "file",
        mediaType: p.mediaType,
        url: p.url,
        ...(typeof p.filename === "string" ? { filename: p.filename } : {}),
      });
    }
  }
  return parts;
}

/**
 * A client id worth keeping: the AI SDK's `generateId`, UUIDs and nanoids all
 * fit. Anything else (a number, an object, a path, a multi-kilobyte string) is
 * replaced rather than rejected — the id is a convenience for the client, not
 * something a send should fail over.
 */
function isUsableId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function voiceOf(metadata: unknown): AppMetadata["voice"] | undefined {
  const durationMs = asRecord(asRecord(metadata)?.voice)?.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? { durationMs }
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
