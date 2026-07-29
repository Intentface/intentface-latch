import os from "node:os";
import path from "node:path";
import type { Experimental_SandboxSession } from "ai";
import type { Principal } from "../session";
import { createJustBashSession, workspaceDir } from "./just-bash";
import { createDaytonaSession } from "./daytona";
import { createMirageSession } from "./mirage";
import type { GoogleMountCreds } from "../google-workspace";
import { sandboxTools, appTools, renderTools } from "./tools";

/**
 * The sandbox seam wired for the platform: a per-session `SandboxSession`
 * resolver (just-bash default; Daytona and mirage opt-in) and the default
 * harness tools. Built via `createSandboxResolver(deps)` and passed to
 * `createRuntime({ sandbox, harnessTools })`.
 *
 * Per-session = one sandbox per chat. just-bash and mirage persist to a host
 * directory keyed by `[orgId,userId,chatId]` (the same directory, so an agent
 * switched between them keeps its files); Daytona persists in an org volume
 * under the same path. chatIds are client-chosen so the key is owner-prefixed.
 */
// On serverless (Vercel/Lambda) the deploy dir is read-only — only the OS
// tmpdir is writable, so sandboxes are per-instance-ephemeral there. Use the
// Daytona provider when files must outlive a warm instance.
const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const SANDBOX_BASE =
  process.env.LATCH_SANDBOX_DIR ??
  (SERVERLESS
    ? path.join(os.tmpdir(), "latch-sandbox")
    : path.join(process.cwd(), ".latch-sandbox"));

export interface SandboxDeps {
  /** Bot token of the agent's dedicated Slack app (org Vault), or null. */
  slackTokenForAgent?: (agent: string, principal: Principal) => Promise<string | null>;
  /** The chat user's google_workspace mount credentials, or null. */
  googleForUser?: (principal: Principal) => Promise<GoogleMountCreds | null>;
}

export function createSandboxResolver(deps: SandboxDeps = {}) {
  return async function resolveSandbox(args: {
    principal: Principal;
    chatId: string;
    agent: string;
    provider?: string;
  }): Promise<Experimental_SandboxSession> {
    const orgId = args.principal.orgId;
    const userId = args.principal.userId ?? "_";
    if (args.provider === "daytona") {
      return createDaytonaSession({ orgId, userId, chatId: args.chatId });
    }
    if (args.provider === "mirage") {
      // Credential lookup failures degrade to fewer mounts, never a dead sandbox.
      const [slackToken, google] = await Promise.all([
        deps.slackTokenForAgent?.(args.agent, args.principal).catch(() => null) ?? null,
        deps.googleForUser?.(args.principal).catch(() => null) ?? null,
      ]);
      return createMirageSession({
        workspaceDir: workspaceDir(SANDBOX_BASE, orgId, userId, args.chatId),
        slackToken,
        google,
      });
    }
    return createJustBashSession({
      workspaceDir: workspaceDir(SANDBOX_BASE, orgId, userId, args.chatId),
    });
  };
}

export const harnessTools = { sandbox: sandboxTools, app: appTools, render: renderTools };
