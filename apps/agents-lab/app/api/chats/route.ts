import { db, listChats, owner } from "@/lib/agent";
import { currentPrincipal } from "@/lib/principal";

export async function GET() {
  const principal = await currentPrincipal();
  if (!principal) return new Response("Sign in first.", { status: 401 });
  // Scoped by owner: another org's conversations are not listed, and not
  // merely hidden in the UI.
  return Response.json({ chats: listChats(db(), owner(principal)) });
}
