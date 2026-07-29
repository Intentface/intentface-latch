import { createServer } from "node:http";
import { createEvalOAuth, liveUrl, REDIRECT_PORT } from "./eval-oauth.js";

/**
 * One-time OAuth consent for the live Loredex eval (`pnpm eval:auth-live`):
 * prints the authorization URL, catches the browser redirect on
 * `localhost:${REDIRECT_PORT}/callback`, exchanges the code, and stores the
 * tokens in `~/.loredex-eval/vault.json`. Re-run with `--reset` to discard
 * stored credentials and start over.
 */

async function main(): Promise<void> {
  const oauth = createEvalOAuth();

  if (process.argv.includes("--reset")) {
    await oauth.provider({}).invalidateCredentials?.("all");
    console.log("stored credentials cleared.");
  }

  const started = await oauth.start({});
  if (started.status === "authorized") {
    console.log("already authorized — tokens are in ~/.loredex-eval/vault.json.");
    console.log("(use --reset to re-consent from scratch)");
    return;
  }

  const params = await new Promise<{ code: string; state?: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        code
          ? "<h3>Authorized — you can close this tab and return to the terminal.</h3>"
          : `<h3>Authorization failed: ${error ?? "no code returned"}</h3>`,
      );
      server.close();
      if (code) resolve({ code, state: url.searchParams.get("state") ?? undefined });
      else reject(new Error(`authorization failed: ${error ?? "no code returned"}`));
    });
    server.listen(REDIRECT_PORT, () => {
      console.log(`Authorize the eval client for ${liveUrl()}\n`);
      console.log(`  OPEN THIS URL IN YOUR BROWSER:\n\n  ${started.authorizationUrl}\n`);
      console.log(`waiting for the callback on localhost:${REDIRECT_PORT} …`);
    });
    server.on("error", reject);
  });

  await oauth.finish({}, params);
  console.log("\nauthorized — tokens stored in ~/.loredex-eval/vault.json (0600).");
  console.log("next: pnpm eval:seed-live, then pnpm eval:memory-search:live");
}

await main();
