import { tool } from "ai";
import { z } from "zod";
import type { AgentBuilderExtension } from "@intentface/latch-agent-builder";
import type { Principal } from "@/lib/session";
import { isOrgAdmin } from "@/lib/auth";
import { secretDependents, secretKey } from "@/lib/connection-store";
import { upsertConnection, normalizeConnectionName } from "@/lib/connection-upsert";
import type { ConnectionInput } from "@/lib/connection-upsert";

/**
 * Builder extension: create integrations from the conversation — secrets by
 * reference (never a value in the model's context), MCP/OpenAPI connections,
 * OAuth hand-off. Org-scoped connections and secrets are admin-managed, the
 * same gate the Connections page applies.
 */

const SCOPE = z.enum(["user", "org"]);

/**
 * One field on the secret form. `secret: true` means the value is written
 * straight from the browser into the Vault under `name` and NEVER comes back to
 * the model — the agent gets the name and passes it as a `*Ref`. `secret: false`
 * is an ordinary value (a client id, an account slug) returned in the result.
 */
const SECRET_FIELD = z.object({
  key: z.string().min(1).describe('Identifier for this field in the result, e.g. "clientId".'),
  label: z.string().min(1).describe('Shown above the input, e.g. "Client Secret".'),
  secret: z
    .boolean()
    .describe(
      "true = the value is stored in the Vault and you only ever see its name. false = a plain value returned to you.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      'Vault name for a secret field, e.g. "strava_client_secret". REQUIRED when secret is true — this is the handle you pass to create_connection as clientSecretRef/tokenRef.',
    ),
  hint: z.string().optional().describe("One short line telling the user where to find this value."),
});

const REQUEST_SECRET_INPUT = z.object({
  title: z.string().min(1).describe('Heading for the form, e.g. "Strava API credentials".'),
  scope: SCOPE.describe(
    "Where the secrets are stored. Must match the scope of the connection they will back. 'org' requires the user to be an org admin.",
  ),
  fields: z.array(SECRET_FIELD).min(1).max(6),
});

/**
 * `create_connection`'s input — the connection record, with `*Ref` vault names
 * standing in for the two secret-bearing fields. A raw secret must never appear
 * here: the input is echoed verbatim on the approval card and into the model's
 * own context.
 */
// strictObject: an undeclared `token` / `clientSecret` must FAIL validation.
// A plain z.object would strip them silently, and the raw-secret guard in
// `execute` could never fire — the model would learn nothing.
const CREATE_CONNECTION_INPUT = z.strictObject({
  name: z.string().min(1).describe('Connection id, kebab/snake case (e.g. "strava").'),
  kind: z.enum(["mcp", "openapi"]),
  scope: SCOPE.describe("'user' (personal) or 'org' (shared). Never guess — ask."),
  url: z.string().optional().describe("MCP only: the server URL."),
  spec: z.string().optional().describe("OpenAPI only: the spec URL (or inline spec)."),
  baseUrl: z.string().optional().describe("OpenAPI only: override the spec's server URL."),
  operations: z
    .string()
    .optional()
    .describe("OpenAPI only: comma-separated operationId allow-list. Omit for all."),
  authMode: z
    .enum(["none", "token", "oauth", "oauth2"])
    .optional()
    .describe(
      "'none'; 'token' = static bearer/header (needs tokenRef); 'oauth' = MCP discovery flow (no credentials); 'oauth2' = OpenAPI pre-registered client (needs authorizeUrl, tokenUrl, clientId, clientSecretRef).",
    ),
  authHeader: z
    .string()
    .optional()
    .describe('Header name for a static token when it is not "Authorization: Bearer".'),
  tokenRef: z
    .string()
    .optional()
    .describe("Vault name of the static token, from request_secret. Omit on edit to keep the stored one."),
  authorizeUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  clientId: z.string().optional().describe("Not a secret — pass the value directly."),
  clientSecretRef: z
    .string()
    .optional()
    .describe("Vault name of the oauth2 client secret, from request_secret. Omit on edit to keep the stored one."),
  scopes: z
    .string()
    .optional()
    .describe("Whitespace-separated scope items (a provider's own commas survive inside one item)."),
});

const PROMPT_ROUTING = `CONNECTIONS vs AUTHORED TOOLS — pick by what the integration IS:
- The API has an MCP server, or an OpenAPI/Swagger spec, or needs OAuth on the user's behalf → CREATE A CONNECTION. You get auth, token refresh and every endpoint for free.
- No spec, and the value is computation — maths, unit conversion, ranking, merging several calls into one compact answer → AUTHOR A TOOL. A tool can also sit on top of a connection's data.
- Unsure whether a spec exists? Ask the user, or check the vendor's docs. Prefer a connection when one is possible.
During discovery (WORKFLOW step 2): if the agent needs an integration the user doesn't have yet, CREATE IT now — see CREATING A CONNECTION.`;

const PROMPT_CREATING = `CREATING A CONNECTION (list_connections / request_secret / create_connection / connect_connection / list_connection_tools / delete_connection):
1. Gather the non-secret config first: kind (mcp = a server URL; openapi = a spec URL), and for oauth2 the authorize URL, token URL and client id. Propose the URLs you believe are right and have the user confirm them — never invent one silently.
2. ASK THE SCOPE — "user" (just them) or "org" (the whole org). Never guess. Org scope needs them to be an org admin.
3. For every credential, call request_secret. It opens a secure form in the composer; secret fields go straight to the Vault and you get back only the NAME you chose, non-secret fields (like a client id) come back as values. Put related fields in ONE call — e.g. Client ID (secret:false) and Client Secret (secret:true, name:"strava_client_secret") together. If the user Skips, the result says declined — offer another route, don't re-ask in a loop.
4. Call create_connection, passing the vault NAMES as clientSecretRef / tokenRef. It pauses for approval, then opens the connection and reports the tools it found (or why it couldn't).
5. For an oauth/oauth2 connection, call connect_connection — the user authorizes with the provider and this conversation resumes automatically. Then confirm with list_connection_tools.
6. Wire it into an agent with save_agent's connections field, and test_agent it.
Editing: call create_connection again with the SAME name and scope. Omit a *Ref to keep the connection pointing at the secret it already uses; pass a different one to repoint it.
Secrets are held BY REFERENCE — the connection stores the name and the value is read at call time. So: the user replacing a secret on the Connections page rotates every connection using it, with nothing to re-run here; deleting one revokes them. Two connections can deliberately share a credential by naming the same secret (list_secrets shows what each one currently backs). A credential the provider itself rotated needs a fresh request_secret under the SAME name — then nothing else has to change.
delete_connection is destructive and pauses for approval; only call it when the user clearly asks.`;

const PROMPT_CREDENTIALS = `CREDENTIALS — the hard rules:
- NEVER ask the user to type an API key, token, client secret or password into the chat. Always call request_secret; its form is the only safe path, and anything typed in chat is permanently in this conversation's history.
- NEVER write a credential into a tool program. Tool programs are stored in plain text, are visible on the Tools page, and you would have to see the value to write it. If an API needs a key, it needs a CONNECTION with a tokenRef.
- If the user pastes a secret into the chat anyway, tell them plainly that it's now in the history and should be rotated at the provider, then collect the new one with request_secret.
- You cannot read a stored secret back — list_secrets gives you names and what they're used by, never values. That's deliberate; work from the names.
- Known gap: an API with a credential but NO OpenAPI spec fits neither path today (a connection needs a spec, and a tool can't hold a secret). Say so instead of hardcoding the key — the user can point you at a spec URL, or the integration waits for generic HTTP connection support.`;

export const connectionsExtension: AgentBuilderExtension<Principal> = {
  name: "connections",
  promptSections: [PROMPT_ROUTING, PROMPT_CREATING, PROMPT_CREDENTIALS],
  toolApproval: {
    // Persists credentials and grants agents network reach. `request_secret`
    // is deliberately NOT gated — the user typing into its form is the
    // consent, and a gate before it would be a pointless double-confirm.
    create_connection: "user-approval",
    delete_connection: "user-approval",
    // Sends the user to an identity provider to grant real account access.
    connect_connection: "user-approval",
  },
  tools: async (principal) => {
    // Lazy import avoids a static import cycle (latch.ts → agents → here).
    const { getLatch } = await import("@/lib/latch");
    const { connectionStore, dynamic, namedSecrets } = await getLatch();

    /** Org-scoped connections and secrets are admin-managed — same gate as the UI. */
    const orgAdminOk = async (scope: "user" | "org") =>
      scope !== "org" || (await isOrgAdmin(principal.userId!, principal.orgId));

    return {
      list_secrets: tool({
        description:
          "Credentials the user has already stored, by NAME and scope only (values are never readable), with the connections each one currently backs. Pass a name to create_connection as clientSecretRef/tokenRef — reusing one is how two connections share a credential.",
        inputSchema: z.object({}),
        execute: async () => {
          const [secrets, conns] = await Promise.all([
            namedSecrets.list(principal),
            connectionStore.list(principal),
          ]);
          const dependents = secretDependents(conns);
          return secrets.map((s) => ({
            ...s,
            usedBy: dependents.get(secretKey(s.scope, s.name)) ?? [],
          }));
        },
      }),

      // No `execute` — this is client-handled. The turn pauses at
      // `input-available`, the composer renders the form, the browser posts the
      // values straight to `saveSecretsFn`, and the run resumes with a result
      // holding only names + non-secret values. The plaintext never enters a tool
      // input, a tool output, or the message history.
      request_secret: tool({
        description:
          "Ask the user to type credentials into a secure form. Secret fields go straight to the Vault and come back to you as NAMES only; non-secret fields come back as values. Use this for every API key, client secret and token — never ask for one in chat.",
        inputSchema: REQUEST_SECRET_INPUT,
      }),

      create_connection: tool({
        description:
          "Create or update an integration the user's agents can call (upsert by name + scope). Secrets are passed as vault names from request_secret, never as values. Pauses for the user's approval.",
        inputSchema: CREATE_CONNECTION_INPUT,
        execute: async (input) => {
          if (!(await orgAdminOk(input.scope))) {
            return { error: "Only org admins can manage org-shared connections." };
          }
          for (const field of ["clientSecret", "token"] as const) {
            if (field in input) {
              return {
                error: `Pass ${field}Ref (a vault name from request_secret), not ${field}. Raw secrets are not accepted here.`,
              };
            }
          }
          // The refs go into the record as NAMES. Nothing on this path reads a
          // secret's value — `upsertConnection` checks the names exist at this
          // scope, and the plaintext is fetched only at egress.
          const record: ConnectionInput = {
            name: input.name,
            kind: input.kind,
            scope: input.scope,
            url: input.url,
            spec: input.spec,
            baseUrl: input.baseUrl,
            operations: input.operations,
            authMode: input.authMode,
            authHeader: input.authHeader,
            tokenRef: input.tokenRef,
            authorizeUrl: input.authorizeUrl,
            tokenUrl: input.tokenUrl,
            clientId: input.clientId,
            clientSecretRef: input.clientSecretRef,
            scopes: input.scopes,
          };
          const saved = await upsertConnection(principal, record, { connectionStore, dynamic, namedSecrets });
          if (!saved.ok) return { error: saved.error };
          console.log(
            `[connections] upsert name=${saved.name} scope=${input.scope} kind=${input.kind} by=${principal.userId ?? "-"}@${principal.orgId} via=agent-builder`,
          );
          // Open it for real so a bad spec URL or an unreachable MCP server is a
          // fixable error now, not a mystery when the agent runs.
          const interactive = input.authMode === "oauth" || input.authMode === "oauth2";
          try {
            const tools = await dynamic.testTools(saved.name, principal);
            return {
              saved: true,
              name: saved.name,
              scope: input.scope,
              tools,
              note:
                tools.length === 0 && interactive
                  ? `Not authorized yet — call connect_connection({ name: "${saved.name}" }) so the user can grant access, then re-check with list_connection_tools.`
                  : tools.length === 0
                    ? "The connection opened but exposed no tools — check the spec URL or the operations allow-list."
                    : undefined,
            };
          } catch (e) {
            return {
              saved: true,
              name: saved.name,
              scope: input.scope,
              tools: [],
              warning: `Saved, but opening it failed: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        },
      }),

      connect_connection: tool({
        description:
          "Ask the user to authorize an OAuth connection. They'll approve, sign in with the provider, and this conversation resumes automatically. Only for connections whose authMode is 'oauth' or 'oauth2'.",
        inputSchema: z.object({ name: z.string().min(1) }),
        execute: async ({ name }) => ({ connected: true, connection: name }),
      }),

      delete_connection: tool({
        description: "Delete a connection at its scope. Destructive — pauses for approval.",
        inputSchema: z.object({ name: z.string().min(1), scope: SCOPE }),
        execute: async ({ name, scope }) => {
          if (!(await orgAdminOk(scope))) {
            return { error: "Only org admins can manage org-shared connections." };
          }
          const target = normalizeConnectionName(name);
          await connectionStore.remove(principal, scope, target);
          console.log(
            `[connections] delete name=${target} scope=${scope} by=${principal.userId ?? "-"}@${principal.orgId} via=agent-builder`,
          );
          return { deleted: true, name: target, scope };
        },
      }),
    };
  },
};
