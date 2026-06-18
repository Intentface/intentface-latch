import { Hono } from "hono";
import type { AppMessage, Principal, Runtime } from "@intentface/latch-core";

/**
 * A mountable Hono app exposing the runtime over HTTP.
 *
 * Default route: `POST /agents/:agent/:id` — prompt the agent in conversation
 * `:id` (a client-chosen key, tenant-namespaced here), returning a streaming
 * UIMessage Response. Mount it under any prefix + your own middleware (embed),
 * or run it standalone. Auth is BYO via `resolveContext` — the core never
 * authenticates; everything below is scoped by the returned `Principal`.
 */
export interface LatchServerConfig {
  runtime: Runtime;
  /** Map a request to a Principal (your existing auth). */
  resolveContext: (request: Request) => Principal | Promise<Principal>;
}

export function createLatchHono(config: LatchServerConfig): Hono {
  const app = new Hono();

  app.post("/agents/:agent/:id", async (c) => {
    const principal = await config.resolveContext(c.req.raw);
    const agent = c.req.param("agent");
    const rawId = c.req.param("id");
    // Tenant-namespaced chat key: org_a's "ticket-1" ≠ org_b's "ticket-1".
    const chatId = `${principal.orgId}:${rawId}`;
    const body = (await c.req
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    const message = toUserMessage(body);
    return config.runtime.handleChat({
      agent,
      chatId,
      principal,
      message,
      request: c.req.raw,
    });
  });

  return app;
}

/** Accept `{ message }`, `{ text }`, or a `useChat`-style `{ messages }` (last). */
function toUserMessage(body: Record<string, unknown>): AppMessage {
  const explicit = body.message as AppMessage | undefined;
  if (explicit?.parts) return explicit;

  let text = "";
  if (typeof body.text === "string") {
    text = body.text;
  } else if (Array.isArray(body.messages)) {
    const last = body.messages[body.messages.length - 1] as
      | AppMessage
      | undefined;
    text = (last?.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { visibility: "user", createdAt: Date.now() },
  };
}
