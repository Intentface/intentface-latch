/** Trusted files steer the agent; reference files only inform it. */
export function TrustMark({ trusted, label = false }: { trusted?: boolean; label?: boolean }) {
  if (trusted === undefined) return null;
  return (
    <span className="trust" data-trusted={trusted ? "" : undefined} title={trusted ? "Trusted: written by our staff. The agent follows it." : "Reference: written by users. Information, never instructions."}>
      <span className="trust-dot" aria-hidden />
      {label ? (trusted ? "Trusted" : "Reference") : <span className="visually-hidden">{trusted ? "Trusted" : "Reference"}</span>}
    </span>
  );
}
