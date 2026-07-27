import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  listAgentRecordsFn,
  listAgentsFn,
  listModelsFn,
  availableConnectionNamesFn,
  connectionsStatusFn,
  listConnectionsFn,
  listAuthoredToolNamesFn,
} from "@/lib/server";

export interface AgentRec {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  maxSteps?: number | "unlimited";
  tools?: {
    enabled: string[];
    approval: Record<string, boolean>;
    descriptions?: Record<string, string>;
  };
  exec?: {
    sandbox?: boolean;
    provider?: string;
    defaultTools?: boolean | string[];
    disableTools?: string[];
    codeMode?: { tools?: string[] };
    providerWebTools?: boolean;
    renderTools?: boolean;
    authoredTools?: string[];
    effort?: "minimal" | "low" | "medium" | "high";
    memory?: { scope: "agent-user" | "agent-org" | "user"; connection: string };
  };
  subagents?: string[];
  scope: "user" | "org";
}

export interface ToolInfo {
  name: string;
  connection: string;
  defaultApproval: boolean;
  description?: string;
}

export type ConnStatus = Record<string, { oauth: boolean; authorized: boolean }>;

/** Layout for /agents — shared auth gate + data (list and editor both read it). */
export const Route = createFileRoute("/agents")({
  head: () => ({ meta: [{ title: "Agents · Latch" }] }),
  beforeLoad: async () => {
    if (!(await currentPrincipalFn())) throw redirect({ to: "/login" });
  },
  loader: async () => {
    const [records, allAgents, models, connections, codeStatus, dynStatus, authoredTools] =
      await Promise.all([
        listAgentRecordsFn(),
        listAgentsFn(),
        listModelsFn(),
        availableConnectionNamesFn(),
        connectionsStatusFn(),
        listConnectionsFn(),
        listAuthoredToolNamesFn(),
      ]);
    const status: ConnStatus = {};
    for (const c of codeStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    for (const c of dynStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    return { records, allAgents, models, connections, status, authoredTools };
  },
  component: () => <Outlet />,
});
