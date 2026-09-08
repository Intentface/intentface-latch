import { Link } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import type { AgentRecord } from "@/lib/agent-form";
import { Button } from "@/components/ui/button";
import { TRIGGER_LABEL, summarizeProps } from "@/components/extension-page";

/**
 * The agent form's Extensions section: the saved list, each row a link to the
 * extension page (`/agents/extension`), where the editing happens. Extensions
 * are saved on their own, so this section reads the stored record and never
 * edits the form's state.
 */
export function ExtensionsSection({ rec, editing }: { rec: AgentRecord; editing: boolean }) {
  const list = rec.extensions ?? [];
  const search = (name?: string) => ({ agent: rec.name, scope: rec.scope, name });
  return (
    <div className="smooth-shadow-ring-xs smooth-ring-primary-border bg-primary-bg space-y-3 rounded-lg p-3">
      <div className="flex items-center justify-between">
        <span className="text-ink-secondary text-xs font-medium">Extensions</span>
        {editing ? (
          <Button type="button" variant="ghost" size="sm" render={<Link to="/agents/extension" search={search()} />}>
            <Plus className="size-3.5" /> Add extension
          </Button>
        ) : (
          <span className="text-ink-secondary text-xs">Save the agent first</span>
        )}
      </div>
      <p className="text-ink-tertiary text-xs">
        A script runs <em>before</em> the model over this agent's tools; a template renders what it
        returned into the prompt. The result is stored on the user's message, so the model reads exactly
        what ran.
      </p>
      {list.length > 0 && (
        <ul className="divide-primary-border border-primary-border divide-y rounded-md border text-xs">
          {list.map((ext) => (
            <li key={ext.name} className="flex items-center gap-3 px-2.5 py-2">
              <Link to="/agents/extension" search={search(ext.name)} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                <span className="text-ink-primary shrink-0 font-mono">
                  {ext.on === "slash" ? "/" : ""}
                  {ext.name}
                </span>
                <span className="text-ink-secondary shrink-0">{TRIGGER_LABEL[ext.on]}</span>
                <span className="text-ink-secondary truncate">{ext.description || summarizeProps(ext)}</span>
              </Link>
              <Button type="button" variant="ghost" size="sm" render={<Link to="/agents/extension" search={search(ext.name)} />}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
