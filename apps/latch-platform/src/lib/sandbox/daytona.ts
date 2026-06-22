import type { Experimental_SandboxSession, Experimental_SandboxProcess } from "ai";

/**
 * Daytona-backed `Experimental_SandboxSession` — opt-in (needs `DAYTONA_API_KEY`),
 * for real VMs with actual binaries (node/git/etc.). Per-session isolation: one
 * org volume `latch-<orgId>` is mounted at `/vol`, and each chat gets its own
 * subdirectory `/vol/<userId>/<chatId>` used as the workspace (files persist in
 * the volume). Tool paths (relative, or `/workspace/...`) are normalized into
 * that directory so the sandbox tools behave the same as on just-bash.
 *
 * NOTE: exercised only against a live Daytona account; not covered by the
 * offline smoke. The SDK's `process.executeCommand` returns combined output as
 * `result` (no separate stderr), so `stderr` is left empty.
 */
const VOL_MOUNT = "/vol";
const enc = (s: string) => encodeURIComponent(s);
const td = new TextDecoder();
const te = new TextEncoder();

export async function createDaytonaSession(opts: {
  orgId: string;
  userId: string;
  chatId: string;
}): Promise<Experimental_SandboxSession> {
  const { Daytona } = await import("@daytonaio/sdk");
  const daytona = process.env.DAYTONA_API_KEY
    ? new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
    : new Daytona();
  const volume = await daytona.volume.get(`latch-${opts.orgId}`, true);
  const workdir = `${VOL_MOUNT}/${enc(opts.userId)}/${enc(opts.chatId)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sb: any;
  async function sandbox() {
    if (sb) return sb;
    sb = await daytona.create({
      volumes: [{ volumeId: volume.id, mountPath: VOL_MOUNT }],
    } as Parameters<typeof daytona.create>[0]);
    await sb.process.executeCommand(`mkdir -p ${workdir}`);
    return sb;
  }

  // Map tool paths into the per-session workspace dir.
  const abs = (p: string) =>
    p.startsWith("/workspace") ? p.replace("/workspace", workdir)
    : p.startsWith("/") ? p
    : `${workdir}/${p}`;

  const run: Experimental_SandboxSession["run"] = async ({ command, workingDirectory, env }) => {
    const s = await sandbox();
    const r = await s.process.executeCommand(command, workingDirectory ?? workdir, env);
    const stdout: string = r.artifacts?.stdout ?? r.result ?? "";
    return { exitCode: r.exitCode ?? 0, stdout, stderr: "" };
  };

  const readBinary = async (p: string): Promise<Uint8Array | null> => {
    try {
      const buf = await (await sandbox()).fs.downloadFile(abs(p));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  };

  return {
    description:
      `A Linux sandbox (Daytona VM) with real binaries. Working directory ` +
      `${workdir}; files there persist for this conversation.`,
    run,
    spawn: async (options): Promise<Experimental_SandboxProcess> => {
      const r = await run(options);
      const one = (s: string) =>
        new ReadableStream<Uint8Array>({ start(c) { c.enqueue(te.encode(s)); c.close(); } });
      return {
        stdout: one(r.stdout),
        stderr: one(r.stderr),
        wait: async () => ({ exitCode: r.exitCode }),
        kill: async () => {},
      };
    },
    readFile: async ({ path: p }) => {
      const b = await readBinary(p);
      return b ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } }) : null;
    },
    readBinaryFile: async ({ path: p }) => readBinary(p),
    readTextFile: async ({ path: p, startLine, endLine }) => {
      const b = await readBinary(p);
      if (!b) return null;
      const text = td.decode(b);
      if (startLine == null && endLine == null) return text;
      const lines = text.split("\n");
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    },
    writeFile: async ({ path: p, content }) => {
      const chunks: Uint8Array[] = [];
      const reader = content.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); }
      await (await sandbox()).fs.uploadFile(Buffer.concat(chunks.map((c) => Buffer.from(c))), abs(p));
    },
    writeBinaryFile: async ({ path: p, content }) => {
      await (await sandbox()).fs.uploadFile(Buffer.from(content), abs(p));
    },
    writeTextFile: async ({ path: p, content }) => {
      await (await sandbox()).fs.uploadFile(Buffer.from(te.encode(content)), abs(p));
    },
  };
}
