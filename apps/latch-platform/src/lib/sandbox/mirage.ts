import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  Workspace,
  DiskResource,
  SlackResource,
  MountMode,
  type MountSpec,
} from "@struktoai/mirage-node";
import type { Experimental_SandboxSession, Experimental_SandboxProcess } from "ai";

/**
 * mirage-backed `Experimental_SandboxSession` — the connector-mount sandbox.
 * Same simulated-shell model as just-bash, but mounts can be external services
 * exposed as files: `/workspace` is a read-write disk mount on the same
 * per-chat host directory just-bash uses (so switching providers keeps files),
 * and `/slack` (when the agent has a Slack app) is a READ-ONLY view of the
 * Slack workspace — public channels only, enforced by bot-token scopes
 * (`channels:read` without `groups:read`).
 *
 * Security posture (deliberate, don't relax):
 * - `curl`/`wget` builtins are unregistered — mirage has no SSRF allowlist, so
 *   they'd be a data-exfiltration channel from private mounts.
 * - `runtimes: ["vfs"]` drops the pyodide/quickjs code runtimes (no wasm
 *   engines, no code-runtime network access).
 * - `ws.snapshot()` is never wired: snapshots carry unredacted command history
 *   and stdout.
 * - Writes outside `/workspace` are rejected at the session layer too,
 *   belt-and-braces over mirage's read-only mount enforcement.
 *
 * mirage shares session env/cwd across `execute()` calls (known upstream
 * race), so all workspace access is serialized through a promise-chain mutex.
 * There is no close hook on `Experimental_SandboxSession`; per-turn Workspaces
 * are GC'd — benign with vfs-only runtimes (no FUSE, no OS handles).
 */
const WORKSPACE = "/workspace";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

const oneChunk = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });

/**
 * Build a hardened mirage Workspace: read-only default mode, vfs-only
 * runtimes, curl/wget unregistered on every mount. Exported so tests exercise
 * the exact hardening path production uses.
 */
export function createMirageWorkspace(mounts: Record<string, MountSpec>): Workspace {
  const ws = new Workspace(mounts, {
    mode: MountMode.READ, // default for anything not explicitly WRITE
    runtimes: ["vfs"],
  });
  for (const mount of ws.registry.allMounts()) mount.unregister(["curl", "wget"]);
  return ws;
}

export function createMirageSession(opts: {
  /** Host directory backing `/workspace` for this session (per chat). */
  workspaceDir: string;
  /** Bot token of the agent's Slack app; when absent, no `/slack` mount. */
  slackToken?: string | null;
}): Experimental_SandboxSession {
  let ws: Workspace | undefined;

  // Serialize ALL workspace access (execute + fs): mirage's session state is
  // shared across concurrent execute() calls.
  let queue: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function workspace(): Promise<Workspace> {
    if (ws) return ws;
    await mkdir(opts.workspaceDir, { recursive: true });
    const mounts: Record<string, MountSpec> = {
      [WORKSPACE]: [new DiskResource({ root: opts.workspaceDir }), MountMode.WRITE],
    };
    if (opts.slackToken) {
      mounts["/slack"] = [new SlackResource({ token: opts.slackToken }), MountMode.READ];
    }
    ws = createMirageWorkspace(mounts);
    return ws;
  }

  const exec = (
    command: string,
    o: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ) =>
    withLock(async () =>
      (await workspace()).execute(command, {
        // Per-call cwd/env run in an isolated session — matches just-bash's
        // `bash -c` semantics.
        cwd: o.cwd ?? WORKSPACE,
        ...(o.env ? { env: o.env } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      }),
    );

  const guardWrite = (p: string) => {
    if (p !== WORKSPACE && !p.startsWith(`${WORKSPACE}/`)) {
      throw new Error(`writes are only allowed under ${WORKSPACE} (got ${p})`);
    }
  };

  // mirage's fs.writeFile/mkdir don't create parents; walk them into place.
  const ensureParents = async (w: Workspace, p: string) => {
    const dir = path.posix.dirname(p);
    const segments = dir.split("/").filter(Boolean);
    let cur = "";
    for (const seg of segments) {
      cur += `/${seg}`;
      if (!(await w.fs.exists(cur))) await w.fs.mkdir(cur);
    }
  };

  const writeBytes = (p: string, bytes: Uint8Array | string) => {
    guardWrite(p);
    return withLock(async () => {
      const w = await workspace();
      await ensureParents(w, p);
      await w.fs.writeFile(p, bytes);
    });
  };

  const readBinary = (p: string): Promise<Uint8Array | null> =>
    withLock(async () => {
      try {
        return await (await workspace()).fs.readFile(p);
      } catch {
        return null; // missing file
      }
    });

  return {
    description:
      `A Linux-like sandbox (simulated bash over a virtual filesystem). Working ` +
      `directory is ${WORKSPACE}; files there persist for this conversation.` +
      (opts.slackToken
        ? ` /slack is a READ-ONLY mount of the Slack workspace (public channels ` +
          `the bot is in) — browse it with ls/cat/grep.`
        : ``) +
      ` No real system binaries and no network access (curl/wget disabled); ` +
      `built-in shell utilities (cat, ls, grep, sed, etc.) and file I/O only.`,

    run: async ({ command, workingDirectory, env, abortSignal }) => {
      const r = await exec(command, { cwd: workingDirectory, env, signal: abortSignal });
      return { exitCode: r.exitCode, stdout: r.stdoutText, stderr: r.stderrText };
    },

    spawn: async (options): Promise<Experimental_SandboxProcess> => {
      // mirage runs to completion; model a "process" by replaying buffered
      // output. Enough for our tools (which use `run`).
      const r = await exec(options.command, {
        cwd: options.workingDirectory,
        env: options.env,
        signal: options.abortSignal,
      });
      return {
        stdout: oneChunk(r.stdout),
        stderr: oneChunk(r.stderr),
        wait: async () => ({ exitCode: r.exitCode }),
        kill: async () => {},
      };
    },

    readFile: async ({ path: p }) => {
      const bytes = await readBinary(p);
      return bytes ? oneChunk(bytes) : null;
    },
    readBinaryFile: async ({ path: p }) => readBinary(p),
    readTextFile: async ({ path: p, startLine, endLine }) => {
      const text = await withLock(async () => {
        try {
          return await (await workspace()).fs.readFileText(p);
        } catch {
          return null;
        }
      });
      if (text == null) return null;
      if (startLine == null && endLine == null) return text;
      const lines = text.split("\n");
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    },

    writeFile: async ({ path: p, content }) => {
      await writeBytes(p, await collect(content));
    },
    writeBinaryFile: async ({ path: p, content }) => {
      await writeBytes(p, content);
    },
    writeTextFile: async ({ path: p, content }) => {
      await writeBytes(p, content);
    },
  };
}
