/**
 * Multilevel-memory live demo — send one chat turn as a persona over HTTP
 * (real session cookie, real SSE stream, chat kind "user" so the sweep sees it).
 *   node --env-file=.env --import tsx src/scripts/demo-turn.ts <email> <chatId> [< message on stdin]
 * Message comes from stdin (avoids shell-quoting hazards). Prints the
 * interviewer's reply text to stdout. Cookies cached per email in DEMO_STATE_DIR.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3200";
const PASSWORD = process.env.DEMO_PASSWORD ?? "Demo-Latch-2026!";
const AGENT = process.env.DEMO_AGENT ?? "anchor-interview-mem";
const STATE_DIR = process.env.DEMO_STATE_DIR ?? "/tmp/latch-demo-state";

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    // better-auth CSRF-checks the Origin header on POSTs.
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.includes("session_token"));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

async function cookieFor(email: string): Promise<string> {
  // Live session tokens — keep them out of other local users' reach.
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = join(STATE_DIR, `cookie-${email.replace(/[^a-z0-9@.-]/gi, "_")}.txt`);
  if (existsSync(file)) {
    const cached = readFileSync(file, "utf8").trim();
    // Cheap validity probe — better-auth sessions can expire mid-demo.
    const probe = await fetch(`${BASE}/api/latch/chats`, { headers: { cookie: cached } });
    if (probe.ok) return cached;
  }
  const fresh = await signIn(email);
  writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

async function main() {
  const [email, chatId] = process.argv.slice(2);
  if (!email || !chatId) throw new Error("usage: demo-turn.ts <email> <chatId> [< message]");
  const text = readFileSync(0, "utf8").trim();
  if (!text) throw new Error("empty message on stdin");

  const cookie = await cookieFor(email);

  const res = await fetch(`${BASE}/api/latch/agents/${AGENT}/${chatId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`chat POST failed: ${res.status} ${await res.text()}`);
  // Drain the SSE stream to EOF — that's how we know the turn finished.
  await res.text();

  // Read the reply from persisted history (sturdier than parsing SSE chunks).
  const hist = await fetch(`${BASE}/api/latch/chats/${chatId}`, { headers: { cookie } });
  if (!hist.ok) throw new Error(`history GET failed: ${hist.status}`);
  const { messages } = (await hist.json()) as {
    messages: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>;
  };
  const reply = messages
    .filter((m) => m.role === "assistant")
    .at(-1)
    ?.parts?.filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");
  if (!reply) throw new Error("no assistant reply in history");
  console.log(reply);
}

main().catch((e) => {
  console.error(String(e));
  process.exitCode = 1;
});
