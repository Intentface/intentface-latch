/**
 * The trace id a latch run is recorded under: derived from the run id, so
 * anything that knows the run (a feedback button, a later score writer, a link
 * from your own UI) can address its trace without looking it up.
 *
 * The first 32 hex characters of SHA-256(`latch-run:<runId>`), the same id
 * `@intentface/latch-langfuse` produced, so traces recorded before keep
 * matching.
 */
export async function traceIdForRun(runId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`latch-run:${runId}`));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
