import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import type { AppMessage } from "@intentface/latch-core";
import {
  slackManifest,
  createFromManifestUrl,
  SLACK_BOT_SCOPES,
} from "@intentface/latch-channels/slack";
import { telegramApi } from "@intentface/latch-channels/telegram";
import { whatsappApi } from "@intentface/latch-channels/whatsapp";
import { getPrincipal } from "./session";
import { getLatch } from "./latch";
import { normalizeAgentName } from "./agent-store";
import {
  slackVaultKeys,
  SLACK_CONFIG_TOKEN_KEY,
  SLACK_CONFIG_REFRESH_KEY,
} from "./slack-store";
import { createAppFromManifest } from "./slack-admin";
import { telegramVaultKeys } from "./telegram-store";
import { whatsappVaultKeys } from "./whatsapp-store";
import { baseUrl } from "./base-url";
import type { CredentialScope } from "./credentials";

/** API-key connections (REST/OpenAPI) and their credential scope, for the key UI. */
const API_KEY_CONNECTIONS: { name: string; label: string; scope: CredentialScope }[] = [];

/**
 * Server-only reads for SSR route loaders / auth gates. These are thin
 * pass-throughs to the in-process runtime (the framework does the work) — the
 * idiomatic TanStack way to render server-side, not per-endpoint Latch glue.
 * All Latch *operations* (chat, approvals, connections) go through the mounted
 * handler via `latch-client`, not here.
 */

/** Auth gate: the current principal, or null. */
export const currentPrincipalFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const p = await getPrincipal();
    return p ? { orgId: p.orgId, userId: p.userId } : null;
  },
);

/**
 * Recent chats for the sidebar — deliberately lightweight: a capped `listChats`
 * with NO per-chat cost (the run scan below is what made this slow, and the
 * sidebar only renders title/agent). Buffer a few extra rows so subagent
 * threads (`sub_…`) can be filtered out and still leave ~10 real chats.
 */
export const recentChatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const chats = await runtime.listChats({ principal, limit: 25 });
  return chats
    .filter((c) => !c.id.startsWith("sub_"))
    .slice(0, 10)
    .map((c) => ({ id: c.id, title: c.title ?? null, agent: c.agent }));
});

/** The tenant's chats for the chat-list page (includes per-chat cost totals). */
export const listChatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const chats = await runtime.listChats({ principal });
  // Sum each chat's run costs (incl. nested sub_… runs) for a per-chat total.
  const runs = await runtime.listRuns({ principal, limit: 1000 });
  const costByChat = new Map<string, number>();
  for (const r of runs) {
    costByChat.set(r.chatId, (costByChat.get(r.chatId) ?? 0) + (r.costTotal ?? 0));
  }
  // Subagent threads (`sub_…`) are nested under their parent's spawn_agent tool
  // calls, not top-level chats — keep them out of the list.
  return chats
    .filter((c) => !c.id.startsWith("sub_"))
    .map((c) => ({
      id: c.id,
      title: c.title ?? null,
      agent: c.agent,
      updatedAt: c.updatedAt,
      cost: costByChat.get(c.id) ?? 0,
    }));
});

/** The tenant's runs (status, tokens, cost) for the ops panel. */
export const listRunsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const runs = await runtime.listRuns({ principal });
  return runs.map((r) => ({
    id: r.id,
    chatId: r.chatId,
    agent: r.agent,
    status: r.status,
    inputTokens: r.usageInputTokens ?? 0,
    outputTokens: r.usageOutputTokens ?? 0,
    cacheReadTokens: r.usageCacheReadTokens ?? 0,
    cacheWriteTokens: r.usageCacheWriteTokens ?? 0,
    cost: r.costTotal ?? 0,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
  }));
});

/** Client-projected history for one chat (useChat initial messages). */
export const loadHistoryFn = createServerFn({ method: "GET" })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return [] as AppMessage[];
    const { runtime } = await getLatch();
    const messages = await runtime.loadHistory({ chatId, principal });
     
    return messages as any;
  });

/** Whether a chat has an in-flight (server-side) turn — drives the "generating"
 * indicator when a page reload lands on a still-running turn. */
export const chatGeneratingFn = createServerFn({ method: "GET" })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const principal = await getPrincipal();
    if (!principal) return false;
    const { runtime } = await getLatch();
    const runs = await runtime.listRuns({ principal });
    return runs.some((r) => r.chatId === chatId && r.status === "active");
  });

/** Per-connection status for the Connections page. */
export const connectionsStatusFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections } = await getLatch();
    return connections.status(principal);
  },
);

/** API-key connection status (is a key stored for the caller, at its scope). */
export const connectionKeysFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { credentials } = await getLatch();
  return Promise.all(
    API_KEY_CONNECTIONS.map(async (c) => ({
      name: c.name,
      label: c.label,
      scope: c.scope,
      set: await credentials.has(principal, c.name, c.scope),
    })),
  );
});

/** Store an API key for a connection, at its declared scope (user/org). */
export const setConnectionKeyFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; value: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const conn = API_KEY_CONNECTIONS.find((c) => c.name === data.name);
    if (!conn) return { ok: false };
    const { credentials } = await getLatch();
    await credentials.set(principal, conn.name, conn.scope, data.value);
    return { ok: true };
  });

/** UI-added connections visible to the caller (org-shared + personal). */
export const listConnectionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { connectionStore, dynamic } = await getLatch();
  const conns = await connectionStore.list(principal);
  // OAuth status for MCP connections (whether the caller has authorized).
  const status = new Map((await dynamic.status(principal)).map((s) => [s.name, s]));
  // Never return the token to the client — just shape + whether auth is set.
  return conns.map((c) => ({
    name: c.name,
    kind: c.kind,
    scope: c.scope,
    target: c.mcp?.url ?? c.openapi?.spec ?? "",
    hasAuth: c.auth?.kind === "bearer" || c.auth?.kind === "header",
    oauth: c.auth?.kind === "oauth",
    authorized: status.get(c.name)?.authorized ?? true,
  }));
});

/** Add a UI-defined connection (stored encrypted in the Vault at its scope). */
export const addConnectionFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      kind: "mcp" | "openapi";
      scope: "user" | "org";
      url?: string;
      spec?: string;
      baseUrl?: string;
      operations?: string;
      /** MCP only: "oauth" uses the interactive flow (no token); else token/none. */
      authMode?: "none" | "token" | "oauth";
      authHeader?: string;
      token?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = data.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!name) return { ok: false, error: "name required" };
    const auth =
      data.kind === "mcp" && data.authMode === "oauth"
        ? ({ kind: "oauth" } as const)
        : data.token?.trim()
          ? {
              kind: (data.authHeader?.trim() ? "header" : "bearer") as "header" | "bearer",
              header: data.authHeader?.trim() || undefined,
              token: data.token.trim(),
            }
          : undefined;
    const { connectionStore } = await getLatch();
    if (data.kind === "mcp") {
      if (!data.url?.trim()) return { ok: false, error: "url required" };
      await connectionStore.add(principal, data.scope, { kind: "mcp", name, mcp: { url: data.url.trim() }, auth });
    } else {
      if (!data.spec?.trim()) return { ok: false, error: "spec required" };
      const operations = data.operations
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await connectionStore.add(principal, data.scope, {
        kind: "openapi",
        name,
        openapi: {
          spec: data.spec.trim(),
          baseUrl: data.baseUrl?.trim() || undefined,
          operations: operations && operations.length > 0 ? operations : undefined,
        },
        auth,
      });
    }
    return { ok: true };
  });

/** Remove a UI-defined connection at its scope. */
export const removeConnectionFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { connectionStore } = await getLatch();
    await connectionStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The agents available to the caller (code + UI-created), for the picker. */
export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  return runtime.listAgents(principal);
});

/** The model catalog (id + label) for the agent editor's dropdown (from models.dev). */
export const listModelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { models } = await getLatch();
  return models;
});

/** Full UI-created agent records (org + personal), for the editor. */
export const listAgentRecordsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { agentStore } = await getLatch();
  return agentStore.listRecords(principal);
});

/** Connection names an agent can reference (code-declared + the caller's). */
export const availableConnectionNamesFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return [];
    const { connections, connectionStore } = await getLatch();
    const stored = (await connectionStore.list(principal)).map((c) => c.name);
    return Array.from(new Set([...connections.names, ...stored]));
  },
);

/**
 * Enumerate the tools of the given connections for the agent editor: each
 * real tool with whether it's gated by default (so the UI pre-seeds the
 * GET-free / mutating-gated default). Opens the connections live — unauthorized
 * OAuth / unreachable ones contribute nothing.
 */
export const connectionToolsFn = createServerFn({ method: "GET" })
  .validator((names: string[]) => names)
  .handler(async ({ data: names }) => {
    const principal = await getPrincipal();
    if (!principal || names.length === 0) return [];
    const { allConnections } = await getLatch();
    const opened = await allConnections.hostFor(names).open(principal);
    try {
      const approval = (opened.toolApproval ?? {});
      return Object.keys(opened.tools)
        .filter((k) => !k.startsWith("connect_"))
        .map((name) => ({
          name,
          connection: names.find((n) => name.startsWith(`${n}_`)) ?? name.split("_")[0],
          defaultApproval: !!approval[name],
          description:
            (opened.tools[name] as { description?: string } | undefined)?.description ?? undefined,
        }));
    } finally {
      await opened.close();
    }
  });

/** Create or update a UI agent at its scope. */
export const saveAgentFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      title?: string;
      description?: string;
      modelId: string;
      instructions: string;
      connections: string[];
      maxSteps?: number | "unlimited";
      tools?: {
        enabled: string[];
        approval: Record<string, boolean>;
        descriptions?: Record<string, string>;
      };
      exec?: {
        sandbox?: boolean;
        provider?: string;
        defaultTools?: boolean | string[];
        disableTools?: string[];
        codeMode?: { tools?: string[] };
        providerWebTools?: boolean;
        authoredTools?: string[];
        effort?: "minimal" | "low" | "medium" | "high";
      };
      subagents?: string[];
      scope: "user" | "org";
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false, error: "unauthorized" };
    const name = normalizeAgentName(data.name);
    if (!name) return { ok: false, error: "name required" };
    if (!data.instructions.trim()) return { ok: false, error: "instructions required" };
    const { agentStore, authoredTools } = await getLatch();
    // An org agent can only attach ORG-scoped tools — a personal tool wouldn't
    // resolve for other members. Validate before persisting.
    const attached = data.exec?.authoredTools ?? [];
    if (data.scope === "org" && attached.length) {
      const orgTools = new Set(
        (await authoredTools.listFor(principal)).filter((t) => t.scope === "org").map((t) => t.name),
      );
      const personal = attached.filter((n) => !orgTools.has(n));
      if (personal.length) {
        return {
          ok: false,
          error: `Org agents can only use org-scoped tools. Make these org-scoped first: ${personal.join(", ")}.`,
        };
      }
    }
    await agentStore.upsert(principal, {
      name,
      title: data.title?.trim() || undefined,
      description: data.description?.trim() || undefined,
      modelId: data.modelId,
      instructions: data.instructions,
      connections: data.connections,
      maxSteps: data.maxSteps,
      tools: data.tools,
      exec: data.exec,
      subagents: data.subagents,
      scope: data.scope,
    });
    return { ok: true };
  });

/** Delete a UI agent at its scope. */
export const deleteAgentFn = createServerFn({ method: "POST" })
  .validator((data: { name: string; scope: "user" | "org" }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { agentStore } = await getLatch();
    await agentStore.remove(principal, data.scope, data.name);
    return { ok: true };
  });

/** The caller's scheduled agents, for the Schedules page. */
export const listSchedulesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { runtime } = await getLatch();
  const schedules = await runtime.listSchedules({ principal });
  return schedules.map((s) => ({
    id: s.id,
    agent: s.agent,
    cron: s.cron,
    prompt: s.prompt,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt ?? null,
    enabled: s.enabled,
  }));
});

// ── Slack channel: per-agent app onboarding ─────────────────────────────────

/**
 * Generate the Slack app manifest for an agent + the "Create from manifest"
 * deep-link. Used by the editor's Slack section for the manual (B) flow; the
 * one-button (C) flow posts the same manifest to `apps.manifest.create`.
 */
export const slackManifestFn = createServerFn({ method: "GET" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { runtime } = await getLatch();
    const info = (await runtime.listAgents(principal)).find((a) => a.name === agent);
    if (!info) return null;
    const manifest = slackManifest({
      displayName: info.title ?? agent,
      description: info.description,
      requestUrl: `${baseUrl()}/api/slack`,
      redirectUrl: `${baseUrl()}/api/slack/oauth`,
    });
    return {
      manifestJson: JSON.stringify(manifest, null, 2),
      createUrl: createFromManifestUrl(manifest),
    };
  });

/**
 * Bind a (manually created) Slack app by its STATIC credentials — client id +
 * secret + signing secret, all on the app's Basic Information page right after
 * you create it from the manifest (no install needed). We stash them in the
 * Vault, pre-bind the app→agent+owner, and return the "Add to Slack" install
 * URL. The OAuth callback then captures the bot token automatically — so no bot
 * token is ever pasted by hand.
 */
export const installSlackAppFn = createServerFn({ method: "POST" })
  .validator(
    (data: {
      appId: string;
      agent: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials } = await getLatch();

    const keys = slackVaultKeys(data.appId);
    await credentials.set(principal, keys.clientId, "org", data.clientId);
    await credentials.set(principal, keys.clientSecret, "org", data.clientSecret);
    await credentials.set(principal, keys.signingSecret, "org", data.signingSecret);

    const botName =
      (await runtime.listAgents(principal)).find((a) => a.name === data.agent)?.title ?? data.agent;
    await slackStore.bind({
      appId: data.appId,
      agent: data.agent,
      orgId: principal.orgId,
      userId: principal.userId,
      botName,
    });

    const authorizeUrl =
      `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(data.clientId)}` +
      `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(","))}` +
      `&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}` +
      `&state=${encodeURIComponent(data.appId)}`;
    return { ok: true as const, authorizeUrl };
  });

/** The caller's org's bound Slack apps (for the editor's status view). */
export const listSlackAppsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { slackStore } = await getLatch();
  return slackStore.listForOrg(principal.orgId);
});

/** Unbind a Slack app from its agent (leaves the Slack app itself untouched). */
export const unbindSlackAppFn = createServerFn({ method: "POST" })
  .validator((appId: string) => appId)
  .handler(async ({ data: appId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { slackStore } = await getLatch();
    await slackStore.unbind(appId);
    return { ok: true };
  });

// ── C: one-button create via org App-Configuration token ────────────────────

/** Whether this org has a Slack config token stored (enables one-button create). */
export const slackConfigStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return { configured: false };
  const { credentials } = await getLatch();
  return { configured: await credentials.has(principal, SLACK_CONFIG_TOKEN_KEY, "org") };
});

/** Store the org's Slack App-Configuration token (+ refresh) in the Vault. */
export const setSlackConfigTokenFn = createServerFn({ method: "POST" })
  .validator((data: { token: string; refreshToken: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { credentials } = await getLatch();
    await credentials.set(principal, SLACK_CONFIG_TOKEN_KEY, "org", data.token);
    await credentials.set(principal, SLACK_CONFIG_REFRESH_KEY, "org", data.refreshToken);
    return { ok: true };
  });

/**
 * One-button: create this agent's Slack app from its manifest (config token),
 * stash its secrets in the Vault, pre-bind it, and return the install URL. The
 * browser is then redirected there; the OAuth callback finishes by storing the
 * bot token. No tokens are ever pasted by hand.
 */
export const createSlackAppFn = createServerFn({ method: "POST" })
  .validator((agent: string) => agent)
  .handler(async ({ data: agent }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { runtime, slackStore, credentials } = await getLatch();

    const configToken = await credentials.get(principal, SLACK_CONFIG_TOKEN_KEY, "org");
    if (!configToken) return { ok: false as const, error: "no_config_token" };
    const refreshToken =
      (await credentials.get(principal, SLACK_CONFIG_REFRESH_KEY, "org")) ?? undefined;

    const info = (await runtime.listAgents(principal)).find((a) => a.name === agent);
    if (!info) return { ok: false as const, error: "unknown_agent" };
    const displayName = info.title ?? agent;

    const manifest = slackManifest({
      displayName,
      description: info.description,
      requestUrl: `${baseUrl()}/api/slack`,
      redirectUrl: `${baseUrl()}/api/slack/oauth`,
    });

    let created;
    try {
      created = await createAppFromManifest({
        configToken,
        refreshToken,
        manifest,
        onRotate: async (rot) => {
          await credentials.set(principal, SLACK_CONFIG_TOKEN_KEY, "org", rot.token);
          await credentials.set(principal, SLACK_CONFIG_REFRESH_KEY, "org", rot.refreshToken);
        },
      });
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "create_failed" };
    }

    const keys = slackVaultKeys(created.appId);
    await credentials.set(principal, keys.signingSecret, "org", created.signingSecret);
    await credentials.set(principal, keys.clientId, "org", created.clientId);
    await credentials.set(principal, keys.clientSecret, "org", created.clientSecret);
    await slackStore.bind({
      appId: created.appId,
      agent,
      orgId: principal.orgId,
      userId: principal.userId,
      botName: displayName,
    });

    // Send the installer to Slack; we carry the app id back via `state`.
    const sep = created.oauthAuthorizeUrl.includes("?") ? "&" : "?";
    const authorizeUrl = `${created.oauthAuthorizeUrl}${sep}state=${encodeURIComponent(created.appId)}&redirect_uri=${encodeURIComponent(`${baseUrl()}/api/slack/oauth`)}`;
    return { ok: true as const, authorizeUrl };
  });

// ── Authored tools (latch_tools): sandboxed JS/TS programs over input + fetch ──

/** The caller's authored tools — for the Tools page (code + schema editable). */
export const listAuthoredToolsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { authoredTools } = await getLatch();
  const tools = await authoredTools.listFor(principal);
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    code: t.code,
    // JSON string — editable directly + serializer-safe.
    inputSchema: JSON.stringify(t.inputSchema ?? { type: "object" }, null, 2),
    allowedHosts: t.allowedHosts,
    scope: t.scope,
    updatedAt: t.updatedAt,
  }));
});

/** Lightweight names (+ scope) for the agent editor's tool picker. */
export const listAuthoredToolNamesFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { authoredTools } = await getLatch();
  const tools = await authoredTools.listFor(principal);
  return tools.map((t) => ({ name: t.name, description: t.description, scope: t.scope }));
});

/** Create or update an authored tool from the UI. Rename / scope-change = move. */
export const saveAuthoredToolFn = createServerFn({ method: "POST" })
  .validator(
    (t: {
      name: string;
      description: string;
      inputSchema?: string;
      code: string;
      allowedHosts?: string[];
      scope?: "user" | "org";
      originalName?: string;
      originalScope?: "user" | "org";
    }) => t,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "not authenticated" };
    const { authoredTools } = await getLatch();
    const name = authoredTools.cleanName(data.name);
    if (!name) return { ok: false as const, error: "invalid name" };
    if (authoredTools.isReserved(name)) {
      return { ok: false as const, error: `"${name}" is a reserved tool name — pick another.` };
    }
    if (!data.code.trim()) return { ok: false as const, error: "code is empty" };
    let inputSchema: unknown = { type: "object" };
    if (data.inputSchema != null && data.inputSchema.trim()) {
      try {
        inputSchema = JSON.parse(data.inputSchema);
      } catch {
        return { ok: false as const, error: "input schema is not valid JSON" };
      }
    }
    const scope = data.scope === "org" ? "org" : "user";
    const original = data.originalName ? authoredTools.cleanName(data.originalName) : undefined;
    const originalScope = data.originalScope === "org" ? "org" : "user";
    const moved = !!original && (original !== name || originalScope !== scope);
    // A rename/scope-change must not silently clobber a different existing tool.
    if (moved && (await authoredTools.getFor(principal, scope, name))) {
      return { ok: false as const, error: `A ${scope} tool named "${name}" already exists.` };
    }
    // Save the new record FIRST, then drop the old one — so a failed save can
    // never lose the original (no transaction across the two writes).
    await authoredTools.saveFor(principal, scope, {
      name,
      description: String(data.description),
      inputSchema,
      // Normalize hosts the same way save_tool does (drop scheme/path).
      allowedHosts: (data.allowedHosts ?? []).map(authoredTools.cleanHost).filter(Boolean),
      code: data.code,
    });
    if (moved && original) await authoredTools.deleteFor(principal, originalScope, original);
    return { ok: true as const, name, scope };
  });

/** Run an authored program once against the caller's allowlist — the Test panel. */
export const testAuthoredToolFn = createServerFn({ method: "POST" })
  .validator((t: { code: string; input?: unknown; allowedHosts?: string[] }) => t)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { status: "error" as const, error: "not authenticated" };
    const { authoredTools } = await getLatch();
    const r = await authoredTools.run({
      code: data.code,
      input: data.input ?? null,
      allowedHosts: data.allowedHosts,
    });
    return r.status === "completed"
      ? { status: "completed" as const, result: JSON.stringify(r.result ?? null, null, 2) }
      : { status: "error" as const, error: r.error };
  });

/** Delete an authored tool by name + scope. */
export const deleteAuthoredToolFn = createServerFn({ method: "POST" })
  .validator((t: { name: string; scope?: "user" | "org" }) => t)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { authoredTools } = await getLatch();
    await authoredTools.deleteFor(principal, data.scope === "org" ? "org" : "user", authoredTools.cleanName(data.name));
    return { ok: true };
  });

// ── Telegram channel: per-agent bot onboarding ───────────────────────────────

/**
 * Editor-side authorization for a channel bot binding: same org, and — since a
 * binding is created by (and may serve) one specific member's personal agent —
 * only its creator may see or manage it. A binding without a recorded creator
 * is unmanageable (fail closed) — org-shared management would need an explicit
 * role gate; until then every binding is creator-owned.
 */
const canManageBot = (
  bot: { orgId: string; userId?: string },
  principal: { orgId: string; userId?: string },
): boolean => bot.orgId === principal.orgId && !!bot.userId && bot.userId === principal.userId;

/**
 * The scope of the agent record a new channel binding will serve — personal
 * wins on a name clash, mirroring turn-time resolution (agent-store `find`).
 * Persisted on the bot row so webhook turns pin resolution to this exact
 * record. Undefined = not in the store (a code-registry agent).
 */
const boundAgentScope = async (
  agentStore: { listRecords: (p: { orgId: string; userId?: string }) => Promise<{ name: string; scope: string }[]> },
  principal: { orgId: string; userId?: string },
  agent: string,
): Promise<"org" | "user" | undefined> => {
  const records = await agentStore.listRecords(principal);
  const match =
    records.find((r) => r.name === agent && r.scope === "user") ??
    records.find((r) => r.name === agent);
  return match?.scope === "org" || match?.scope === "user" ? match.scope : undefined;
};

/** The caller's Telegram bots (for the editor's status view). */
export const listTelegramBotsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { telegramStore } = await getLatch();
  const bots = await telegramStore.listForOrg(principal.orgId);
  return bots
    .filter((b) => canManageBot(b, principal))
    .map((b) => ({ ...b, eventsUrl: `${baseUrl()}/api/telegram/${b.id}/events` }));
});

/** Create a Telegram bot row for an agent (token pasted in a second step). */
export const createTelegramBotFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; handle: string; displayName?: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { telegramStore, agentStore } = await getLatch();
    const id = crypto.randomUUID();
    try {
      await telegramStore.create({
        id,
        agent: data.agent,
        agentScope: await boundAgentScope(agentStore, principal, data.agent),
        orgId: principal.orgId,
        userId: principal.userId,
        handle: data.handle.trim(),
        displayName: data.displayName?.trim() || undefined,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        ok: false as const,
        error: m.includes("UNIQUE") ? "handle already taken" : m,
      };
    }
    return { ok: true as const, botId: id };
  });

/**
 * Save a BotFather token: validate it against Telegram's `getMe`, store it in
 * the Vault along with a fresh server-generated webhook secret (a token save
 * always requires a webhook re-register — the secret rotated).
 */
export const saveTelegramTokenFn = createServerFn({ method: "POST" })
  .validator((data: { botId: string; botToken: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { telegramStore, credentials } = await getLatch();
    const bot = await telegramStore.get(data.botId);
    if (!bot || !canManageBot(bot, principal)) return { ok: false as const, error: "not found" };

    const newToken = data.botToken.trim();
    let me: { username: string };
    try {
      me = await telegramApi(newToken).getMe();
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }

    const keys = telegramVaultKeys(data.botId);
    // "Replace token" flow: the OLD bot account may still have its webhook
    // pointed at this endpoint — once its token is overwritten it can never be
    // cleaned up (it would just collect 401s), so best-effort remove it first.
    const oldToken = await credentials.get(principal, keys.botToken, "org");
    if (oldToken && oldToken !== newToken) {
      await telegramApi(oldToken).deleteWebhook().catch(() => {});
    }
    await credentials.set(principal, keys.botToken, "org", newToken);
    await credentials.set(principal, keys.webhookSecret, "org", randomBytes(24).toString("base64url"));
    await telegramStore.setBotUsername(data.botId, me.username);
    return { ok: true as const, botUsername: me.username };
  });

/** Register (or re-register) the bot's webhook with Telegram. */
export const registerTelegramWebhookFn = createServerFn({ method: "POST" })
  .validator((botId: string) => botId)
  .handler(async ({ data: botId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { telegramStore, credentials } = await getLatch();
    const bot = await telegramStore.get(botId);
    if (!bot || !canManageBot(bot, principal)) return { ok: false as const, error: "not found" };

    const keys = telegramVaultKeys(botId);
    const token = await credentials.get(principal, keys.botToken, "org");
    const secret = await credentials.get(principal, keys.webhookSecret, "org");
    if (!token || !secret) return { ok: false as const, error: "save the bot token first" };

    try {
      await telegramApi(token).setWebhook({
        url: `${baseUrl()}/api/telegram/${botId}/events`,
        secretToken: secret,
      });
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
    await telegramStore.markWebhookRegistered(botId);
    return { ok: true as const };
  });

/** Telegram's view of the bot's webhook (URL, backlog, last error). */
export const telegramWebhookStatusFn = createServerFn({ method: "GET" })
  .validator((botId: string) => botId)
  .handler(async ({ data: botId }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { telegramStore, credentials } = await getLatch();
    const bot = await telegramStore.get(botId);
    if (!bot || !canManageBot(bot, principal)) return null;
    const token = await credentials.get(principal, telegramVaultKeys(botId).botToken, "org");
    if (!token) return null;
    try {
      return await telegramApi(token).getWebhookInfo();
    } catch {
      return null;
    }
  });

/** Delete a Telegram bot binding (best-effort webhook removal first). */
export const deleteTelegramBotFn = createServerFn({ method: "POST" })
  .validator((botId: string) => botId)
  .handler(async ({ data: botId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { telegramStore, credentials } = await getLatch();
    const bot = await telegramStore.get(botId);
    if (!bot || !canManageBot(bot, principal)) return { ok: false };
    const token = await credentials.get(principal, telegramVaultKeys(botId).botToken, "org");
    if (token) await telegramApi(token).deleteWebhook().catch(() => {});
    await telegramStore.remove(botId);
    return { ok: true };
  });

// ── WhatsApp channel: per-agent business-number onboarding ───────────────────

/** The caller's WhatsApp bots (for the editor's status view). */
export const listWhatsappBotsFn = createServerFn({ method: "GET" }).handler(async () => {
  const principal = await getPrincipal();
  if (!principal) return [];
  const { whatsappStore } = await getLatch();
  const bots = await whatsappStore.listForOrg(principal.orgId);
  return bots
    .filter((b) => canManageBot(b, principal))
    .map((b) => ({ ...b, callbackUrl: `${baseUrl()}/api/whatsapp/${b.id}/events` }));
});

/** Create a WhatsApp bot row for an agent (credentials pasted in a second step). */
export const createWhatsappBotFn = createServerFn({ method: "POST" })
  .validator((data: { agent: string; handle: string; displayName?: string }) => data)
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { whatsappStore, agentStore } = await getLatch();
    const id = crypto.randomUUID();
    try {
      await whatsappStore.create({
        id,
        agent: data.agent,
        agentScope: await boundAgentScope(agentStore, principal, data.agent),
        orgId: principal.orgId,
        userId: principal.userId,
        handle: data.handle.trim(),
        displayName: data.displayName?.trim() || undefined,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        ok: false as const,
        error: m.includes("UNIQUE") ? "handle already taken" : m,
      };
    }
    return { ok: true as const, botId: id };
  });

/**
 * Save the Meta credentials: validate against the Graph API (fetch the phone
 * number object), store them in the Vault, and generate a webhook verify token
 * if the bot doesn't have one yet (kept stable across saves — the Meta
 * dashboard config keeps working after a token rotation).
 */
export const saveWhatsappCredentialsFn = createServerFn({ method: "POST" })
  .validator(
    (data: { botId: string; accessToken: string; phoneNumberId: string; appSecret: string }) =>
      data,
  )
  .handler(async ({ data }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false as const, error: "unauthorized" };
    const { whatsappStore, credentials } = await getLatch();
    const bot = await whatsappStore.get(data.botId);
    if (!bot || !canManageBot(bot, principal)) return { ok: false as const, error: "not found" };

    const accessToken = data.accessToken.trim();
    const phoneNumberId = data.phoneNumberId.trim();
    const appSecret = data.appSecret.trim();
    // The Graph API check below only exercises the token + phone-number id; an
    // empty app secret would silently key webhook HMAC verification to "".
    if (!accessToken || !phoneNumberId || !appSecret) {
      return { ok: false as const, error: "all three credentials are required" };
    }
    let check: { displayPhoneNumber?: string };
    try {
      check = await whatsappApi({ accessToken, phoneNumberId }).checkCredentials();
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }

    const keys = whatsappVaultKeys(data.botId);
    await credentials.set(principal, keys.accessToken, "org", accessToken);
    await credentials.set(principal, keys.phoneNumberId, "org", phoneNumberId);
    await credentials.set(principal, keys.appSecret, "org", appSecret);
    if (!(await credentials.has(principal, keys.verifyToken, "org"))) {
      await credentials.set(principal, keys.verifyToken, "org", randomBytes(24).toString("base64url"));
    }
    await whatsappStore.setPhoneNumberId(data.botId, phoneNumberId);
    return { ok: true as const, displayPhoneNumber: check.displayPhoneNumber ?? null };
  });

/** What the Meta dashboard needs: the callback URL + verify token pair. */
export const whatsappWebhookInfoFn = createServerFn({ method: "GET" })
  .validator((botId: string) => botId)
  .handler(async ({ data: botId }) => {
    const principal = await getPrincipal();
    if (!principal) return null;
    const { whatsappStore, credentials } = await getLatch();
    const bot = await whatsappStore.get(botId);
    if (!bot || !canManageBot(bot, principal)) return null;
    const verifyToken = await credentials.get(
      principal,
      whatsappVaultKeys(botId).verifyToken,
      "org",
    );
    return {
      callbackUrl: `${baseUrl()}/api/whatsapp/${botId}/events`,
      verifyToken: verifyToken ?? null,
    };
  });

/** Delete a WhatsApp bot binding (the Meta app itself is untouched). */
export const deleteWhatsappBotFn = createServerFn({ method: "POST" })
  .validator((botId: string) => botId)
  .handler(async ({ data: botId }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { whatsappStore } = await getLatch();
    const bot = await whatsappStore.get(botId);
    if (!bot || !canManageBot(bot, principal)) return { ok: false };
    await whatsappStore.remove(botId);
    return { ok: true };
  });
