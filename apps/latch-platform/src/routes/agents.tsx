import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  currentPrincipalFn,
  listAgentRecordsFn,
  listModelsFn,
  availableConnectionNamesFn,
  connectionsStatusFn,
  listConnectionsFn,
} from "@/lib/server";

export interface AgentRec {
  name: string;
  title?: string;
  description?: string;
  modelId: string;
  instructions: string;
  connections: string[];
  maxSteps?: number | "unlimited";
  tools?: { enabled: string[]; approval: Record<string, boolean> };
  exec?: {
    sandbox?: boolean;
    provider?: string;
    defaultTools?: boolean | string[];
    disableTools?: string[];
    codeMode?: { tools?: string[] };
  };
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
    const [records, models, connections, codeStatus, dynStatus] = await Promise.all([
      listAgentRecordsFn(),
      listModelsFn(),
      availableConnectionNamesFn(),
      connectionsStatusFn(),
      listConnectionsFn(),
    ]);
    const status: ConnStatus = {};
    for (const c of codeStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    for (const c of dynStatus) status[c.name] = { oauth: c.oauth, authorized: c.authorized };
    return { records, models, connections, status };
  },
  component: () => <Outlet />,
});
