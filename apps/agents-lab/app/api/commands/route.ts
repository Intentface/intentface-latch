import { listCommands } from "@intentface/agents-sdk";
import { extensionsFor } from "@/lib/agent";
import { currentPrincipal } from "@/lib/principal";

/**
 * The slash palette, DERIVED from the extensions that actually registered
 * commands rather than kept as a second list beside them. A hardcoded menu
 * drifts the moment someone adds or renames a command, and the drift is
 * invisible until a person types the wrong thing.
 */
export async function GET() {
  const principal = await currentPrincipal();
  if (!principal) return new Response("Sign in first.", { status: 401 });
  // The chat id does not matter for the registry; commands are per extension.
  return Response.json({ commands: listCommands(extensionsFor("_", principal)) });
}
