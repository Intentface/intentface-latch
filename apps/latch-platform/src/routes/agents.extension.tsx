import { useEffect, useState } from "react";
import { createFileRoute, Link, useLoaderData, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { connectionToolsFn } from "@/lib/server";
import { ExtensionPage } from "@/components/extension-page";
import type { ToolInfo } from "./agents";

/**
 * /agents/extension?agent=&scope=&name= — one extension of one stored agent,
 * on its own page (a script editor wants the room). `name` absent = new.
 * Reads the agent records from the /agents layout loader; the connections'
 * tools load here because they are only needed for this page.
 */
export const Route = createFileRoute("/agents/extension")({
  validateSearch: (s: Record<string, unknown>) => ({
    agent: typeof s.agent === "string" ? s.agent : "",
    scope: s.scope === "org" ? ("org" as const) : ("user" as const),
    name: typeof s.name === "string" ? s.name : undefined,
  }),
  component: ExtensionRoute,
});

function ExtensionRoute() {
  const { records } = useLoaderData({ from: "/agents" });
  const { agent, scope, name } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const record = records.find((r) => r.name === agent && r.scope === scope);
  const initial = record?.extensions?.find((e) => e.name === name) ?? null;

  const [tools, setTools] = useState<ToolInfo[]>([]);
  useEffect(() => {
    if (!record?.connections.length) return;
    let cancelled = false;
    void connectionToolsFn({ data: record.connections }).then((t) => {
      if (!cancelled) setTools(t);
    });
    return () => {
      cancelled = true;
    };
  }, [record]);

  const back = { to: "/agents/edit" as const, search: { name: agent, scope } };

  if (!record) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Link to="/agents" className="text-ink-secondary hover:text-ink-primary inline-flex items-center gap-1 text-sm">
          <ChevronLeft className="size-4" /> Agents
        </Link>
        <p className="text-ink-secondary text-sm">Agent “{agent}” was not found. Save the agent first, then add extensions to it.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <Link {...back} className="text-ink-secondary hover:text-ink-primary inline-flex items-center gap-1 text-sm">
        <ChevronLeft className="size-4" /> {record.title ?? record.name}
      </Link>
      <ExtensionPage
        key={`${agent}:${scope}:${name ?? "new"}`}
        agentName={record.name}
        scope={scope}
        initial={initial}
        tools={tools}
        onSaved={async (saved) => {
          await router.invalidate();
          if (saved !== name) await navigate({ to: "/agents/extension", search: { agent, scope, name: saved }, replace: true });
        }}
        onDeleted={async () => {
          await router.invalidate();
          await navigate(back);
        }}
      />
    </div>
  );
}
