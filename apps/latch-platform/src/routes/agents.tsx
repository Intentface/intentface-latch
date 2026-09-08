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

// The agent record type comes from the framework (`@intentface/latch-agent-builder`);
// the loader's `records` carry it (minus attachedEvals) via listAgentRecordsFn.

export interface ToolInfo {
  name: string;
  connection: string;
  defaultApproval: boolean;
  description?: string;
  /** The tool's input JSON Schema, serialized — what a script has to pass. */
  inputSchemaJson?: string;
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
