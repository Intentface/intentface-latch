import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/principal";
import { db, listChats, owner, ORG_LIMIT, USER_LIMIT } from "@/lib/agent";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { Console } from "@/components/console";

export default async function Page() {
  const principal = await currentPrincipal();
  if (!principal) redirect("/sign-in");

  const session = await auth.api.getSession({ headers: await headers() });
  const chats = listChats(db(), owner(principal));

  return (
    <Console
      principal={principal}
      email={session?.user.email ?? ""}
      name={session?.user.name ?? ""}
      chats={chats}
      limits={{ org: ORG_LIMIT, user: USER_LIMIT }}
    />
  );
}
