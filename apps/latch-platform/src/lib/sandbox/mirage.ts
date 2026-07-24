import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  Workspace,
  DiskResource,
  SlackResource,
  GDriveResource,
  GmailResource,
  GDocsResource,
  GSheetsResource,
  GSlidesResource,
  SlackAccessor,
  MountMode,
  type MountSpec,
  type PathSpec,
} from "@struktoai/mirage-node";
import type { Experimental_SandboxSession, Experimental_SandboxProcess } from "ai";
import type { GoogleMountCreds } from "../google-workspace";

/**
 * mirage-backed `Experimental_SandboxSession` — the connector-mount sandbox.
 * Same simulated-shell model as just-bash, but mounts can be external services
 * exposed as files: `/workspace` is a read-write disk mount on the same
 * per-chat host directory just-bash uses (so switching providers keeps files),
 * `/slack` (when the agent has a Slack app) is a READ-ONLY view of the
 * Slack workspace — public channels only, enforced by bot-token scopes
 * (`channels:read` without `groups:read`) — and `/gdrive` + `/gmail` (when the
 * CHAT USER has connected `google_workspace`) are READ-ONLY views of that
 * user's own Drive and Gmail, enforced by consent scopes (`drive.readonly`,
 * `gmail.readonly`) on top of the READ mount mode. `/gdocs`, `/gsheets` and
 * `/gslides` add structured per-document views over the same credentials
 * (docs/sheets/slides readonly scopes).
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
    chunks.push(value);
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

type SlackTransport = SlackResource["accessor"]["transport"];

/**
 * mirage's Slack layout exposes `dms/` (every user's private conversation
 * with the bot — the token carries `im:read`/`im:history` for the Slack CHAT
 * channel, not for browsing) and `users/` profiles. Latch's boundary for the
 * mount is PUBLIC CHANNELS ONLY.
 *
 * Enforcement is at the TRANSPORT level — mirage's shell commands close over
 * the raw IO table at module load, so path filters on the resource class (or
 * its registered ops) never see `ls`/`cat`/`grep` traffic. Every Slack API
 * call, from every dispatch path, flows through `accessor.transport`, so the
 * subclass swaps in an allow-list transport:
 * - `conversations.list` → forced to `types=public_channel` (DM/mpim listings
 *   are rejected, private channels never requested);
 * - `conversations.history` → public-channel ids (`C…`) only;
 * - everything else (users.*, search.*, chat.*, reactions.*) → rejected.
 * The fs-level guards below are defense in depth for the `ws.fs` path, and
 * the reach-around commands are unregistered so agents don't see dead tools.
 * Write commands (post/reply/react) are already blocked by MountMode.READ.
 */
export class PublicChannelsSlackResource extends SlackResource {
  /** Commands that hit Slack APIs directly, bypassing path-based reads. */
  private static readonly BLOCKED_COMMANDS = new Set([
    "slack-search",
    "slack-get-users",
    "slack-get-user-profile",
  ]);

  constructor(config: ConstructorParameters<typeof SlackResource>[0]) {
    super(config);
    const real = this.accessor.transport;
    const blocked = (endpoint: string) =>
      new Error(
        `public-channels-only /slack mount: Slack API "${endpoint}" is not allowed`,
      );
    const guarded: SlackTransport = {
      call: async (endpoint, params, body) => {
        if (endpoint === "conversations.list") {
          const types = (params?.types ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
          // Channel listings only (the DM listing asks for im/mpim) — and
          // always narrowed to public channels.
          if (types.length === 0 || !types.every((t) => t.endsWith("_channel"))) {
            throw blocked(`${endpoint}?types=${params?.types ?? ""}`);
          }
          return real.call(endpoint, { ...params, types: "public_channel" }, body);
        }
        if (endpoint === "conversations.history") {
          // DM ids start with D, legacy private groups with G.
          if (!(params?.channel ?? "").startsWith("C")) throw blocked(endpoint);
          return real.call(endpoint, params, body);
        }
        throw blocked(endpoint);
      },
      // File bytes are only reachable via messages in listable channels.
      ...(real.downloadFile ? { downloadFile: (url: string) => real.downloadFile!(url) } : {}),
    };
    // `accessor` is a readonly field on the base class; swap it wholesale so
    // commands, ops, fs, and search all use the guarded transport.
    (this as { accessor: SlackResource["accessor"] }).accessor = new SlackAccessor(guarded);
  }

  private static key(p: PathSpec): string {
    return p.resourcePath.replace(/^\/+/, "");
  }

  private static allowed(p: PathSpec): boolean {
    const key = PublicChannelsSlackResource.key(p);
    return key === "" || key === "channels" || key.startsWith("channels/");
  }

  private static assertAllowed(p: PathSpec): void {
    if (!PublicChannelsSlackResource.allowed(p)) {
      const e = new Error(`ENOENT: ${p.virtual}`) as Error & { code: string };
      e.code = "ENOENT";
      throw e;
    }
  }

  override commands(): ReturnType<SlackResource["commands"]> {
    return super
      .commands()
      .filter((c) => !PublicChannelsSlackResource.BLOCKED_COMMANDS.has(c.name));
  }

  override async readdir(p: PathSpec): Promise<string[]> {
    PublicChannelsSlackResource.assertAllowed(p);
    const names = await super.readdir(p);
    // Root listing advertises dms/ and users/ — hide everything but channels.
    return PublicChannelsSlackResource.key(p) === ""
      ? names.filter((n) => n.split("/").pop() === "channels")
      : names;
  }

  override readFile(p: PathSpec): ReturnType<SlackResource["readFile"]> {
    PublicChannelsSlackResource.assertAllowed(p);
    return super.readFile(p);
  }

  override stat(p: PathSpec): ReturnType<SlackResource["stat"]> {
    PublicChannelsSlackResource.assertAllowed(p);
    return super.stat(p);
  }

  override async glob(
    paths: readonly PathSpec[],
    prefix?: string,
  ): Promise<PathSpec[]> {
    const results = await super.glob(paths, prefix);
    return results.filter((p) => PublicChannelsSlackResource.allowed(p));
  }
}

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
  /** The chat user's Google tokens; when absent, no `/gdrive` or `/gmail`. */
  google?: GoogleMountCreds | null;
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
      mounts["/slack"] = [
        new PublicChannelsSlackResource({ token: opts.slackToken }),
        MountMode.READ,
      ];
    }
    if (opts.google) {
      // refreshFn keeps the client secret on our side; mirage only ever holds
      // the refresh token + short-lived access tokens. Its TokenManager never
      // reads clientSecret when refreshFn is set — the empty string only
      // satisfies the config type.
      const cfg = {
        clientId: opts.google.clientId,
        clientSecret: "",
        refreshToken: opts.google.refreshToken,
        refreshFn: opts.google.refreshFn,
      };
      mounts["/gdrive"] = [new GDriveResource(cfg), MountMode.READ];
      mounts["/gmail"] = [new GmailResource(cfg), MountMode.READ];
      // Structured per-document views (tabs/sheets/slides rendered as files) —
      // same creds, gated by the docs/sheets/slides readonly consent scopes.
      mounts["/gdocs"] = [new GDocsResource(cfg), MountMode.READ];
      mounts["/gsheets"] = [new GSheetsResource(cfg), MountMode.READ];
      mounts["/gslides"] = [new GSlidesResource(cfg), MountMode.READ];
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
      (opts.google
        ? ` /gdrive, /gmail, /gdocs, /gsheets and /gslides are READ-ONLY ` +
          `mounts of the user's own Google Drive, Gmail, Docs, Sheets and ` +
          `Slides — browse them with ls/cat/grep.`
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
