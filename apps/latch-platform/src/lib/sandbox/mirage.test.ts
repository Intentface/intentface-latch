import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RAMResource, MountMode, type Workspace } from "@struktoai/mirage-node";
import { afterEach, describe, expect, it } from "vitest";
import { createMirageWorkspace, createMirageSession } from "./mirage";

/**
 * Security-posture tests for the mirage sandbox. These assert the hardening
 * conditions the integration was approved under — if one starts failing after
 * a mirage upgrade, treat it as a release blocker, not a flaky test.
 */

const open: Workspace[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((ws) => ws.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function workspace(mounts: Parameters<typeof createMirageWorkspace>[0]): Workspace {
  const ws = createMirageWorkspace(mounts);
  open.push(ws);
  return ws;
}

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mirage-test-"));
  dirs.push(dir);
  return dir;
}

describe("createMirageWorkspace hardening", () => {
  it("keeps ordinary shell builtins working", async () => {
    const ws = workspace({ "/data": [new RAMResource(), MountMode.WRITE] });
    const r = await ws.execute("echo hi");
    expect(r.exitCode).toBe(0);
    expect(r.stdoutText).toBe("hi\n");
  });

  it("rejects curl and wget (exfiltration channel — no SSRF allowlist)", async () => {
    const ws = workspace({ "/data": [new RAMResource(), MountMode.WRITE] });
    for (const cmd of ["curl https://example.com", "wget https://example.com"]) {
      const r = await ws.execute(cmd);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderrText).toMatch(/command not found/i);
    }
  });

  it("rejects writes to read-only mounts", async () => {
    const ws = workspace({ "/ro": [new RAMResource(), MountMode.READ] });
    const redirect = await ws.execute("echo x > /ro/f.txt");
    expect(redirect.exitCode).not.toBe(0);
    const touch = await ws.execute("touch /ro/f.txt");
    expect(touch.exitCode).not.toBe(0);
    const read = await ws.execute("cat /ro/f.txt");
    expect(read.exitCode).not.toBe(0); // nothing was created
  });
});

describe("createMirageSession", () => {
  it("round-trips files under /workspace and persists them to the host dir", async () => {
    const dir = await scratchDir();
    const session = createMirageSession({ workspaceDir: dir });
    await session.writeTextFile!({ path: "/workspace/notes/a.txt", content: "hello" });
    expect(await session.readTextFile!({ path: "/workspace/notes/a.txt" })).toBe("hello");
    // The persistence seam: the file must exist on the host, where a later
    // turn's fresh session (or just-bash) will find it.
    expect(await readFile(path.join(dir, "notes/a.txt"), "utf-8")).toBe("hello");
  });

  it("rejects session-level writes outside /workspace", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    await expect(
      session.writeTextFile!({ path: "/slack/channels/x", content: "x" }),
    ).rejects.toThrow(/only allowed under \/workspace/);
    await expect(
      session.writeTextFile!({ path: "/workspacefake/x", content: "x" }),
    ).rejects.toThrow(/only allowed under \/workspace/);
  });

  it("returns null for missing files", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    expect(await session.readTextFile!({ path: "/workspace/nope.txt" })).toBeNull();
    expect(await session.readBinaryFile!({ path: "/workspace/nope.bin" })).toBeNull();
  });

  it("runs commands with cwd defaulting to /workspace", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    const r = await session.run({ command: "pwd" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("/workspace");
  });

  it("serializes concurrent runs without cross-talk (per-session mutex)", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    await session.run({ command: "mkdir -p /workspace/a /workspace/b" });
    const [ra, rb] = await Promise.all([
      session.run({ command: "pwd", workingDirectory: "/workspace/a" }),
      session.run({ command: "pwd", workingDirectory: "/workspace/b" }),
    ]);
    expect(ra.stdout.trim()).toBe("/workspace/a");
    expect(rb.stdout.trim()).toBe("/workspace/b");
  });

  it("disables curl/wget in sessions too", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    const r = await session.run({ command: "curl https://example.com" });
    expect(r.exitCode).not.toBe(0);
  });

  it("mounts /gdrive and /gmail read-only when google creds are present", async () => {
    // Resource construction is lazy (no network) — only mount topology and
    // write rejection are asserted here.
    const session = createMirageSession({
      workspaceDir: await scratchDir(),
      google: {
        clientId: "test-client",
        refreshToken: "rt",
        refreshFn: async () => ({ accessToken: "at", expiresIn: 3600 }),
      },
    });
    const ls = await session.run({ command: "ls /" });
    expect(ls.stdout).toContain("gdrive");
    expect(ls.stdout).toContain("gmail");
    for (const p of ["/gdrive/x.txt", "/gmail/x.txt"]) {
      const w = await session.run({ command: `echo x > ${p}` });
      expect(w.exitCode).not.toBe(0);
      // gdrive: READ mount → "read-only"; gmail: no write op registered at all.
      expect(w.stderr).toMatch(/read-only|no op registered: write/i);
      await expect(session.writeTextFile!({ path: p, content: "x" })).rejects.toThrow(
        /only allowed under \/workspace/,
      );
    }
  });

  it("omits google mounts without creds", async () => {
    const session = createMirageSession({ workspaceDir: await scratchDir() });
    const ls = await session.run({ command: "ls /" });
    expect(ls.stdout).not.toContain("gdrive");
    expect(ls.stdout).not.toContain("gmail");
  });
});
