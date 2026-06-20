import {
  defineOpenApiConnection,
  type OpenApiAuth,
} from "@intentface/latch-openapi";
import type { Principal } from "@/lib/session";
import type { CredentialScope } from "@/lib/credentials";

/**
 * Clockify (time tracking / billable hours) as an OpenAPI connection — it has no
 * MCP server, just a REST API. Read-only operations the Weekly brief needs are
 * allow-listed (the full spec has 110+); the API key is workspace-wide, so its
 * credential scope is "org". The spec lists no `servers`, so we set `baseUrl`.
 */
export const clockifyScope: CredentialScope = "org";

/** Hosts the OpenAPI registry may reach: the spec doc + the API. */
export const clockifyHosts = ["docs.clockify.me", "api.clockify.me"];

export function clockify(auth: OpenApiAuth<Principal>) {
  return defineOpenApiConnection<Principal>({
    spec: "https://docs.clockify.me/openapi.json",
    baseUrl: "https://api.clockify.me/api",
    description:
      "Clockify time tracking — the user's workspaces, projects, and time entries (billable hours).",
    operations: {
      allow: [
        "getLoggedUser",
        "getWorkspacesOfUser",
        "getProjects",
        "getTimeEntries",
        "getInProgressTimeEntries",
        "getHolidaysInPeriod",
      ],
    },
    auth,
  });
}
