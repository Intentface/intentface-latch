import { createFileRoute, redirect } from "@tanstack/react-router";
import { currentPrincipalFn, listRunsFn } from "@/lib/server";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/runs")({
  beforeLoad: async () => {
    const principal = await currentPrincipalFn();
    if (!principal) throw redirect({ to: "/login" });
  },
  loader: () => listRunsFn(),
  component: RunsPage,
});

const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  completed: "secondary",
  awaiting_input: "outline",
  active: "default",
  errored: "destructive",
};

function RunsPage() {
  const runs = Route.useLoaderData();
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);
  const totalTokens = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-lg font-semibold">Runs</h1>
        <div className="text-muted-foreground text-sm">
          {runs.length} runs · {totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(4)}
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground text-center text-sm">
                  No runs yet — chat with an agent to create one.
                </TableCell>
              </TableRow>
            )}
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Badge variant={statusVariant[r.status] ?? "outline"}>{r.status}</Badge>
                </TableCell>
                <TableCell>{r.agent}</TableCell>
                <TableCell className="text-right tabular-nums">{r.inputTokens}</TableCell>
                <TableCell className="text-right tabular-nums">{r.outputTokens}</TableCell>
                <TableCell className="text-right tabular-nums">${r.cost.toFixed(4)}</TableCell>
                <TableCell className="text-muted-foreground text-right text-sm">
                  {new Date(r.startedAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
