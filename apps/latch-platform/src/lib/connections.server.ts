import { createServerFn } from "@tanstack/react-start";
import { getPrincipal } from "./session";
import { getLatch, LOREDEX_TOKEN_KEY } from "./latch";

/** Whether the org has connected Loredex (a token is in the Vault). */
export const connectionStatusFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return { loredex: false };
    const { vault } = await getLatch();
    return { loredex: await vault.has(principal, LOREDEX_TOKEN_KEY) };
  },
);

/** Save the org's Loredex API token (envelope-encrypted in the Vault). */
export const saveLoredexTokenFn = createServerFn({ method: "POST" })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }) => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { vault } = await getLatch();
    await vault.set(principal, LOREDEX_TOKEN_KEY, token.trim());
    return { ok: true };
  });

/** Remove the Loredex connection. */
export const disconnectLoredexFn = createServerFn({ method: "POST" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return { ok: false };
    const { vault } = await getLatch();
    await vault.delete(principal, LOREDEX_TOKEN_KEY);
    return { ok: true };
  },
);

/** Open the MCP host and return the discovered tool names (verifies the token). */
export const testLoredexFn = createServerFn({ method: "GET" }).handler(
  async () => {
    const principal = await getPrincipal();
    if (!principal) return { tools: [] as string[] };
    const { mcpHost } = await getLatch();
    const { tools, close } = await mcpHost.open(principal);
    try {
      return { tools: Object.keys(tools) };
    } finally {
      await close();
    }
  },
);
