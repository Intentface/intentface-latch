<!-- Generated from apps/docs/content/docs/concepts/secrets.mdx by apps/docs/scripts/build-skill.mjs. Edit the page, not this file. -->

# Secrets (the vault)

Per-customer API keys and sign-in tokens, encrypted in your database, used by your tools and never seen by the model.

Online: https://intentface-latch-docs.vercel.app/docs/concepts/secrets

Tools often need a credential that belongs to a customer: the CRM key they pasted into your settings, their Slack bot's token, the token from their Linear sign-in. **The vault keeps these encrypted in your own database, per customer, and hands them only to your server code.** The model never sees them.

| Use the vault for | Not for |
| --- | --- |
| API keys your customers give you | your own app's keys: those belong in environment variables |
| Bot tokens and webhook secrets per customer | anything the model should read: that goes in the context or a tool result |
| OAuth tokens from users connecting a service (Latch stores these itself) | what a chat is about: that's [params](./inputs.md) |

## Set it up

```ts title="lib/vault.ts"
import { createVault } from "@intentface/latch-core";
import { createPostgresSecretStore } from "@intentface/latch-drizzle";

export const vault = createVault<Principal>({
  // Whose secret it is: a person, or the whole team when there's no userId.
  store: createPostgresSecretStore(db, {
    owner: (p) => (p.userId ? [p.orgId, p.userId] : [p.orgId]),
  }),
  masterKey: process.env.LATCH_VAULT_KEY!, // 32 random bytes, base64
});
```

Generate the master key once and keep it in your environment or key manager, never in the database:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **Keep the master key safe, and keep it**
>
> Every secret is encrypted with it. Lose it, or change it, and every stored secret becomes unreadable; there's no built-in way to re-encrypt under a new key yet. On Node, `deriveMasterKey(passphrase, { salt })` from `@intentface/latch-core/node` turns a passphrase into a master key, if that's easier to manage.

## Put secrets in

Your own settings page saves them. The vault is plain server code; nothing in Latch exposes it over HTTP.

```ts title="app/api/settings/crm/route.ts"
export async function POST(req: Request) {
  const user = await requireAdmin(req);                       // your check: who may set it
  const { apiKey } = await req.json();
  await vault.set({ orgId: user.orgId }, "crm_api_key", apiKey); // the whole team's key
  return Response.json({ connected: true });                  // never send the value back
}

// elsewhere
await vault.has({ orgId }, "crm_api_key");   // "connected" in your settings UI
await vault.list({ orgId });                 // key names, never values
await vault.delete({ orgId }, "crm_api_key"); // disconnect
```

Setting a key again replaces it. That's how a customer rotates one: the next tool call uses the new value.

## Whose secret is it?

The principal you pass, and the store's `owner`, decide. With the setup above:

| You pass | Owner | Who shares it |
| --- | --- | --- |
| `{ orgId, userId }` | `[orgId, userId]` | one person, like their personal API key |
| `{ orgId }` | `[orgId]` | the whole team, like the company's CRM key |

A tool reads it back with the same shape: `vault.get({ orgId: principal.orgId }, "crm_api_key")` for the team's key, `vault.get(principal, …)` for a personal one. Another customer's key is never found, the same way another customer's chat isn't.

The secret store's `owner` is separate from the chat storage's, so team-wide credentials can sit next to private chats. It also receives the key, for when one kind of secret should always be personal and another always shared:

```ts
createPostgresSecretStore(db, {
  owner: (p, key) => (key?.startsWith("team:") || !p.userId ? [p.orgId] : [p.orgId, p.userId]),
});
```

`vault.list` passes no key, so `owner` decides from the principal alone: here `vault.list(principal)` lists the personal keys and `vault.list({ orgId })` the team's. Make sure your `owner` handles a call without a key.

## Use them in tools

A tool reads the secret when it runs, uses it to call the service, and returns only the result:

```ts
const lookup_customer = tool({
  description: "Look up a customer in the CRM",
  inputSchema: z.object({ email: z.string() }),
  execute: async ({ email }, { context }) => {
    const { principal } = context as ToolContext<Principal, Ctx>;
    const apiKey = await vault.get({ orgId: principal.orgId }, "crm_api_key");
    if (!apiKey) return { error: "Connect your CRM in Settings first." };
    const res = await fetch(`https://crm.example.com/customers?email=${encodeURIComponent(email)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const customer = await res.json();
    return { name: customer.name, plan: customer.plan }; // the data, never the key
  },
});
```

Reading it inside the tool, rather than in your route, also means it's there when an answer continues after an approval or a crash: tools run with the restored principal, so the lookup works the same.

## Connections use the same vault

- **Signing in to a service** (`oauth()` in [`createMcpConnections`](https://intentface-latch-docs.vercel.app/docs/reference/mcp)): each user's tokens are saved in the vault under `mcp_oauth:<connection>:…`, refreshed when they expire, and removed when the user disconnects.
- **A key you supply** (`bearer()`): `createMcpConnections({ vault, secrets: vault.resolver, … })` and `bearer({ getToken: (p) => vault.get(p, "crm_token") })` send it as the server's `Authorization` header.

Either way the token goes from the vault to the request, and never into the conversation.

## What protects them

- **Encrypted per secret.** Each value is encrypted with its own random key (AES-256-GCM), and that key is encrypted with your master key. A copy of the database alone reveals nothing.
- **Server only.** Values reach your code and the requests it makes. The model, the browser, logs and traces see them only if your code puts them there.
- **Scoped by owner.** Reads are limited to the owner the principal maps to.

## Common mistakes

| Mistake | What goes wrong | Instead |
| --- | --- | --- |
| A key in the instructions, params or `data-context` | Saved in the conversation, sent to the model, and possibly repeated in an answer | Read it inside the tool |
| A tool returning the raw response, headers included | The model can see, and repeat, whatever came back | Return only the fields the model needs |
| Reading the key in your route and passing it along | It isn't there when an answer continues, and it travels further than needed | Read it in the tool from the restored principal |
| The master key in the database or the repo | Encryption protects nothing | An environment variable or a key manager |
| Rotating the master key like an API key | Every stored secret becomes unreadable | Keep it stable; rotate customers' keys with `vault.set` |

## Go deeper

- Every method: [Vault reference](../reference/vault.md)
- Signing in to services: [Connecting accounts](https://intentface-latch-docs.vercel.app/docs/hard-parts/connections), [Connect other services](../guides/connections.md)
