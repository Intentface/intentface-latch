import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createMcpOAuth,
  createOAuthDiscoveryFetch,
  type FetchFunction,
  type McpOAuth,
} from "@intentface/latch-mcp";
import type { Vault } from "@intentface/latch-core";

/**
 * OAuth wiring for the live Loredex eval (the workspace MCP endpoint is
 * OAuth-only — no static tokens). Reuses the repo's `createMcpOAuth`
 * (Authorization Code + PKCE + Dynamic Client Registration) with a tiny
 * file-backed Vault at `~/.loredex-eval/vault.json` (0600, outside the repo)
 * instead of the platform's DB vault.
 *
 * One-time consent: `pnpm eval:auth-live` (see `auth.ts`). After that the
 * seed/run scripts read tokens from the file vault and the MCP transport
 * auto-refreshes them.
 */

export const LIVE_CONNECTION = "memory-eval-lore";
export const DEFAULT_URL = "https://app.loredex.ai/ws_TdbVcB4G2riEgXUZ9Qjhs/mcp";
export const liveUrl = (): string => process.env.LOREDEX_EVAL_URL ?? DEFAULT_URL;

export const REDIRECT_PORT = 8976;
const REDIRECT_URL = `http://localhost:${REDIRECT_PORT}/callback`;

const VAULT_DIR = path.join(homedir(), ".loredex-eval");
const VAULT_PATH = path.join(VAULT_DIR, "vault.json");

/** Single-user file vault: principal is ignored, values live in one 0600 JSON file. */
function createFileVault(): Vault<unknown> {
  const load = (): Record<string, string> =>
    existsSync(VAULT_PATH)
      ? (JSON.parse(readFileSync(VAULT_PATH, "utf8")) as Record<string, string>)
      : {};
  const save = (data: Record<string, string>): void => {
    mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
    // mode applies at creation (no default-mode window); chmod covers a file
    // that already existed with wider permissions.
    writeFileSync(VAULT_PATH, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(VAULT_PATH, 0o600);
  };
  return {
    async set(_p, key, value) {
      const data = load();
      data[key] = value;
      save(data);
    },
    async get(_p, key) {
      return load()[key];
    },
    async has(_p, key) {
      return load()[key] !== undefined;
    },
    async delete(_p, key) {
      const data = load();
      delete data[key];
      save(data);
    },
    async list() {
      return Object.keys(load());
    },
    resolver: async (_p: unknown, key: string) => load()[key],
  };
}

/**
 * Loredex's authorization-server metadata declares its issuer with a trailing
 * slash (`https://app.loredex.ai/`), which the SDK's strict RFC 8414 check
 * rejects. This normalizing fetch fixes the discovery documents only, for this
 * host only — wire it into BOTH the OAuth flow and the host transport (per its
 * own docs) so the on-401 refresh path sees the same normalization.
 */
export function evalDiscoveryFetch(): FetchFunction {
  return createOAuthDiscoveryFetch({ hosts: [new URL(liveUrl()).hostname] });
}

export function createEvalOAuth(): McpOAuth<unknown> {
  return createMcpOAuth<unknown>({
    vault: createFileVault(),
    config: {
      name: LIVE_CONNECTION,
      serverUrl: liveUrl(),
      redirectUrl: REDIRECT_URL,
      clientMetadata: {
        client_name: "latch-memory-eval",
        redirect_uris: [REDIRECT_URL],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      allowedAuthorizationServers: [new URL(liveUrl()).origin],
      scope: "mcp:read mcp:write",
      fetch: evalDiscoveryFetch(),
    },
  });
}
