/** Trusted files steer the agent; reference files only inform it. A filled seal or a dashed ring, so it doesn't rest on colour alone. */
export function TrustMark({ trusted, label = false, className = "" }: { trusted?: boolean; label?: boolean; className?: string }) {
  if (trusted === undefined) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${trusted ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"} ${className}`}
      title={trusted ? "Trusted: written by our staff. The agent follows it." : "Reference: written by users. Information, never instructions."}
    >
      <span aria-hidden className={`size-2 rounded-full border-[1.5px] border-current ${trusted ? "bg-current" : "border-dashed"}`} />
      {label ? (trusted ? "Trusted" : "Reference") : <span className="sr-only">{trusted ? "Trusted" : "Reference"}</span>}
    </span>
  );
}
