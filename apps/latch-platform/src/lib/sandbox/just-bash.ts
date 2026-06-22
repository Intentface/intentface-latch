import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  Sandbox,
  MountableFs,
  InMemoryFs,
  ReadWriteFs,
} from "just-bash";
import type { Experimental_SandboxSession, Experimental_SandboxProcess } from "ai";

/**
 * `just-bash` backed `Experimental_SandboxSession` — the default, zero-infra
 * sandbox. A simulated bash with a virtual filesystem; `/workspace` is mounted
 * onto a real per-session directory on disk, so files persist across the turns
 * of one chat (the session key is the directory path). It's a JS interpreter —
 * there are no real `node`/`git` binaries (use the Daytona backend for those).
 *
 * One `Sandbox` instance is created lazily and reused for all tool calls within
 * a turn (the runtime resolves one session per turn). Persistence is the disk
 * mount, so no serialize/restore step is needed.
 */
const WORKSPACE = "/workspace";

const enc = (s: string) => encodeURIComponent(s);
const toBytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

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

export function createJustBashSession(opts: {
  /** Host directory backing `/workspace` for this session (per chat). */
  workspaceDir: string;
}): Experimental_SandboxSession {
  let sb: Sandbox | undefined;
  async function sandbox(): Promise<Sandbox> {
    if (sb) return sb;
    await mkdir(opts.workspaceDir, { recursive: true });
    sb = await Sandbox.create({
      cwd: WORKSPACE,
      fs: new MountableFs({
        base: new InMemoryFs(),
        mounts: [
          { mountPoint: WORKSPACE, filesystem: new ReadWriteFs({ root: opts.workspaceDir }) },
        ],
      }),
    });
    return sb;
  }

  const readBinary = async (p: string): Promise<Uint8Array | null> => {
    try {
      return toBytes(await (await sandbox()).readFile(p, "base64"));
    } catch {
      return null; // missing file
    }
  };

  return {
    description:
      `A Linux-like sandbox (simulated bash). Working directory is ${WORKSPACE}; ` +
      `files there persist for this conversation. No real system binaries — ` +
      `built-in shell utilities (cat, ls, grep, sed, etc.) and file I/O only.`,

    run: async ({ command, workingDirectory, env, abortSignal }) => {
      // `command` is a full shell line — run it through bash -c so pipes,
      // redirects, and globs are parsed (cmd:<string> would be a literal name).
      const r = await (await sandbox()).runCommand({
        cmd: "bash",
        args: ["-c", command],
        cwd: workingDirectory ?? WORKSPACE,
        env,
        signal: abortSignal,
      });
      return { exitCode: r.exitCode, stdout: await r.stdout(), stderr: await r.stderr() };
    },

    spawn: async (options): Promise<Experimental_SandboxProcess> => {
      // just-bash runs synchronously; model a "process" by running to completion
      // and replaying buffered output. Enough for our tools (which use `run`).
      const r = await (await sandbox()).runCommand({
        cmd: "bash",
        args: ["-c", options.command],
        cwd: options.workingDirectory ?? WORKSPACE,
        env: options.env,
        signal: options.abortSignal,
      });
      const out = await r.stdout();
      const err = await r.stderr();
      return {
        stdout: oneChunk(new Uint8Array(Buffer.from(out))),
        stderr: oneChunk(new Uint8Array(Buffer.from(err))),
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
      let text: string;
      try {
        text = await (await sandbox()).readFile(p, "utf-8");
      } catch {
        return null;
      }
      if (startLine == null && endLine == null) return text;
      const lines = text.split("\n");
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    },

    writeFile: async ({ path: p, content }) => {
      const bytes = await collect(content);
      await (await sandbox()).writeFiles({ [p]: { content: toB64(bytes), encoding: "base64" } });
    },
    writeBinaryFile: async ({ path: p, content }) => {
      await (await sandbox()).writeFiles({ [p]: { content: toB64(content), encoding: "base64" } });
    },
    writeTextFile: async ({ path: p, content }) => {
      await (await sandbox()).writeFiles({ [p]: content });
    },
  };
}

/** Host directory for a chat's workspace, isolated by owner (chatIds aren't global). */
export function workspaceDir(base: string, orgId: string, userId: string, chatId: string): string {
  return path.join(base, enc(orgId), enc(userId), enc(chatId));
}
