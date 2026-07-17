import path from "node:path";
import type { Experimental_SandboxSession } from "ai";
import type { Principal } from "../session";
import { createJustBashSession, workspaceDir } from "./just-bash";
import { createDaytonaSession } from "./daytona";
import { sandboxTools, appTools, renderTools } from "./tools";

/**
 * The sandbox seam wired for the platform: a per-session `SandboxSession`
 * resolver (just-bash default, Daytona opt-in) and the default harness tools.
 * Passed to `createRuntime({ sandbox, harnessTools })`.
 *
 * Per-session = one sandbox per chat. just-bash persists to a host directory
 * keyed by `[orgId,userId,chatId]`; Daytona persists in an org volume under the
 * same path. chatIds are client-chosen so the key is owner-prefixed.
 */
const SANDBOX_BASE =
  process.env.LATCH_SANDBOX_DIR ?? path.join(process.cwd(), ".latch-sandbox");

export async function resolveSandbox(args: {
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
  return createJustBashSession({
    workspaceDir: workspaceDir(SANDBOX_BASE, orgId, userId, args.chatId),
  });
}

export const harnessTools = { sandbox: sandboxTools, app: appTools, render: renderTools };
