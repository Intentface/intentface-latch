import { ORG_LIMIT, USER_LIMIT, db, readSpend } from "@/lib/agent";
import { currentPrincipal } from "@/lib/principal";

/** What the Spend tab reads: the same ledger the ceilings are enforced against. */
export async function GET() {
  const principal = await currentPrincipal();
  if (!principal) return new Response("Sign in first.", { status: 401 });
  const d = db();
  return Response.json({
    org: { spend: readSpend(d, principal.orgId, "month"), limit: ORG_LIMIT, key: principal.orgId },
    user: { spend: readSpend(d, principal.userId, "day"), limit: USER_LIMIT, key: principal.userId },
  });
}
