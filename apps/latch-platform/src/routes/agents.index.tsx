import { useState } from "react";
import { createFileRoute, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { Bot, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { deleteAgentFn } from "@/lib/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { AgentRec } from "./agents";

export const Route = createFileRoute("/agents/")({ component: AgentsList });

function AgentsList() {
  const { records } = useLoaderData({ from: "/agents" });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-ink-primary text-lg font-semibold tracking-tight">Agents</h1>
          <p className="text-ink-secondary mt-0.5 text-sm">
            A name, a system prompt, a model, and the connections it can use. Agents show up in
            the chat picker and can be scheduled. (Code-defined agents live in the repo.)
          </p>
        </div>
        <Button
          render={<Link to="/agents/edit" search={{ name: undefined, scope: undefined }} />}
          className="shrink-0 gap-1.5"
        >
          <Plus className="size-4" /> New agent
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="border-primary-border text-ink-tertiary flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Bot className="size-6 opacity-60" />
          <p className="text-sm">No custom agents yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(records as AgentRec[]).map((a) => (
            <AgentCard key={`${a.scope}:${a.name}`} agent={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentRec }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    await deleteAgentFn({ data: { name: agent.name, scope: agent.scope } });
    await router.invalidate();
    setBusy(false);
  }
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3 py-3">
        <div className="bg-tertiary border-primary-border text-ink-secondary grid size-9 shrink-0 place-items-center rounded-lg border">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agent.title ?? agent.name}</span>
            {agent.exec?.sandbox && (
              <span className="text-ink-tertiary flex items-center gap-1 text-xs">
                <TerminalSquare className="size-3.5" /> sandbox
              </span>
            )}
            <Badge variant="outline" className="ml-auto">
              {agent.scope === "org" ? "org" : "personal"}
            </Badge>
          </div>
          <p className="text-ink-tertiary truncate text-xs">
            <span className="font-mono">{agent.modelId}</span>
            {" · "}
            {agent.connections.length ? agent.connections.join(", ") : "no connections"}
            {" · "}
            {agent.maxSteps === "unlimited" ? "until done" : `${agent.maxSteps ?? "default"} steps`}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            render={<Link to="/agents/edit" search={{ name: agent.name, scope: agent.scope }} />}
            size="sm"
            variant="outline"
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={remove} aria-label="Delete">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
