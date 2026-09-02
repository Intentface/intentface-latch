import { useEffect } from "react";
import { createFileRoute, Link, useLoaderData, useNavigate } from "@tanstack/react-router";
import { Bot, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Settings } from "@/components/ui/settings";

export const Route = createFileRoute("/agents/")({
  // Slack link/install flows redirect back here with ?slack=… to toast.
  validateSearch: (s: Record<string, unknown>): { slack?: string } =>
    typeof s.slack === "string" ? { slack: s.slack } : {},
  component: AgentsList,
});

const SLACK_TOASTS: Record<string, { kind: "success" | "error"; msg: string }> = {
  linked: { kind: "success", msg: "Slack account linked — you can use the bot now." },
  connected: { kind: "success", msg: "Slack app connected." },
  link_error: { kind: "error", msg: "Couldn't link your Slack account — try the link again." },
};

const countLabel = (n: number) =>
  n === 0 ? "No custom agents yet" : `${n} agent${n === 1 ? "" : "s"}`;

function AgentsList() {
  const { records } = useLoaderData({ from: "/agents" });
  const { slack } = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    if (!slack) return;
    const t = SLACK_TOASTS[slack];
    if (t) toast[t.kind](t.msg);
    // Clear the param so the toast doesn't re-fire on refresh/back.
    void navigate({ to: "/agents", search: {}, replace: true });
  }, [slack, navigate]);

  const agents = records;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <Settings>
        <Settings.Header>
          <Settings.Heading>
            <Settings.Title>Agents</Settings.Title>
            <Settings.Subtitle>
              A name, a system prompt, a model, and the connections it can use. Agents show up
              in the chat picker and can be scheduled.
            </Settings.Subtitle>
          </Settings.Heading>
        </Settings.Header>

        <Settings.Card>
          <Settings.Row>
            <Settings.LabelGroup>
              <Settings.Summary>{countLabel(agents.length)}</Settings.Summary>
            </Settings.LabelGroup>
            {agents.length === 0 ? (
              <Button
                variant="ghost"
                className="rounded-full"
                render={<Link to="/agents/edit" search={{ name: undefined, scope: undefined }} />}
              >
                <Plus className="size-4" />
                New agent
              </Button>
            ) : (
              <IconButton
                aria-label="New agent"
                variant="ghost"
                className="rounded-full"
                render={<Link to="/agents/edit" search={{ name: undefined, scope: undefined }} />}
              >
                <Plus className="size-4" />
              </IconButton>
            )}
          </Settings.Row>

          {agents.map((agent) => (
            <Settings.Row
              key={`${agent.scope}:${agent.name}`}
              render={
                <Link to="/agents/edit" search={{ name: agent.name, scope: agent.scope }} />
              }
            >
              <Settings.Icon>
                <Bot />
              </Settings.Icon>
              <Settings.LabelGroup>
                <Settings.Label>{agent.title ?? agent.name}</Settings.Label>
                <Settings.Description className="block truncate">
                  <span className="font-mono">{agent.modelId}</span>
                  {" · "}
                  {agent.connections.length ? agent.connections.join(", ") : "no connections"}
                  {" · "}
                  {agent.maxSteps === "unlimited"
                    ? "until done"
                    : `${agent.maxSteps ?? "default"} steps`}
                  {agent.exec?.sandbox ? " · sandbox" : ""}
                </Settings.Description>
              </Settings.LabelGroup>
              <Settings.Value className="text-xs">
                {agent.scope === "org" ? "org" : "personal"}
              </Settings.Value>
              <Settings.Chevron />
            </Settings.Row>
          ))}
        </Settings.Card>
      </Settings>
    </div>
  );
}
