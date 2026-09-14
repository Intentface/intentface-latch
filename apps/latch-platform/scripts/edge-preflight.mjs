/**
 * Edge Eval — the three things a fresh checkout needs before any eval script can even be
 * imported. Deliberately dependency-free and workspace-import-free: it runs BEFORE the
 * packages it would otherwise import are guaranteed to exist.
 *
 *   node --env-file-if-exists=.env scripts/edge-preflight.mjs
 *
 * 1. Workspace packages are built. `pnpm install` alone leaves packages/<x>/dist missing, and
 *    every edge:* script then dies at import with ERR_MODULE_NOT_FOUND before it can say why.
 *    Turbo answers in ~0.6s when nothing changed, so this is unconditional.
 * 2. `.env` exists. Created from .env.example if not, with the still-empty keys listed —
 *    their values are secrets and can only come from a human.
 * 3. The local database has its schema. A `file:` URL pointing at a missing or empty file is
 *    migrated (idempotent — the same `pnpm db:migrate` you would run by hand).
 *
 * Exit 0 = the eval scripts can run. Exit 1 = a human has to paste secrets first.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const APP = resolve(import.meta.dirname, "..");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** 1. Workspace packages built (turbo-cached; ~0.6s when they already are). */
function build() {
  try {
    run("pnpm", ["build"], REPO_ROOT);
  } catch (e) {
    console.error(`\n  ✗ the workspace packages did not build\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    console.error(`  → fix the build, or run it yourself: (cd ${REPO_ROOT} && pnpm install && pnpm build)\n`);
    process.exit(1);
  }
}

/** 2. `.env` present. Copying the example is free; the secrets in it are not. */
function env() {
  const envPath = resolve(APP, ".env");
  const example = resolve(APP, ".env.example");
  if (!existsSync(envPath)) {
    if (!existsSync(example)) {
      console.error(`\n  ✗ no .env and no .env.example in ${APP}\n`);
      process.exit(1);
    }
    copyFileSync(example, envPath);
    console.log(`\n  Created apps/latch-platform/.env from .env.example.`);
  }
  const needed = ["DATABASE_URL", "BETTER_AUTH_SECRET", "LATCH_VAULT_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LOREDEX_EVAL_WS_ID", "LOREDEX_EVAL_API_KEY"];
  const text = readFileSync(envPath, "utf8");
  const blank = needed.filter((key) => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return !m || !m[1].trim();
  });
  if (!blank.length) return;
  console.log(`\n  ${blank.length} value${blank.length > 1 ? "s" : ""} in apps/latch-platform/.env still need${blank.length > 1 ? "" : "s"} a human:\n`);
  for (const key of blank) console.log(`    ${key}=`);
  console.log(`
  BETTER_AUTH_SECRET you generate yourself:

    node -e "console.log(crypto.randomBytes(32).toString('base64'))"

  DATABASE_URL can stay file:./latch.db. The rest are secrets — ask whoever runs the
  benchmark (the two LOREDEX_EVAL_* values are a read-only key for the client workspace).
  Paste them into apps/latch-platform/.env and run the command again.
`);
  process.exit(1);
}

/** 3. Schema in the local database. Only for `file:` URLs — a remote db is not ours to migrate. */
function database() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) return;
  const file = resolve(APP, url.slice("file:".length));
  if (existsSync(file) && statSync(file).size > 0) return;
  console.log(`  Creating the local database schema (${url}) …`);
  try {
    run("pnpm", ["db:migrate"], APP);
  } catch (e) {
    console.error(`\n  ✗ could not create the schema\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    console.error(`  → run it yourself: (cd apps/latch-platform && pnpm db:migrate)\n`);
    process.exit(1);
  }
}

build();
env();
database();
