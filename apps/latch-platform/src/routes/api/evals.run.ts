import { createFileRoute } from "@tanstack/react-router";
import { getPrincipalFromHeaders } from "@/lib/session";
import { runEvalSet } from "@/lib/evals/run-set";

/**
 * Run an eval set, streaming each case as it lands.
 *
 * `runEvalSetFn` returns the whole run at once, which is correct and, on a real
 * model, means a button that goes grey for the better part of a minute. It
 * cannot say whether the run is working, wedged, or nearly finished, and the
 * first case's verdict — usually the one someone is waiting for — is held back
 * until the last case has also finished.
 *
 * So the same work is available here as NDJSON, one JSON object per line:
 *
 *   {"type":"start","cases":[{id,name},…]}
 *   {"type":"case","result":{…},"done":1,"total":3}
 *   {"type":"done","run":{…},"ref":"hn-digest@2"}
 *   {"type":"error","error":"…"}
 *
 * NDJSON rather than SSE because there is no reconnection story to want: this
 * is one request, it either finishes or the user reloads and reads the saved
 * run. The run row is written at the end either way, so a dropped connection
 * costs the live view and nothing else.
 */

export const Route = createFileRoute("/api/evals/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const principal = await getPrincipalFromHeaders(request.headers);
        if (!principal)
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });

        const body = (await request.json().catch(() => null)) as {
          agent?: string;
          name?: string;
          version?: number | "draft";
        } | null;
        if (!body?.agent || !body.name)
          return new Response(JSON.stringify({ error: "agent and name are required" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (o: unknown) => {
              try {
                controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
              } catch {
                // The client navigated away mid-run. The run itself carries on
                // and is still saved — only the live view is lost.
              }
            };
            try {
              const res = await runEvalSet({
                principal,
                agent: body.agent!,
                name: body.name!,
                ...(body.version !== undefined ? { version: body.version } : {}),
                onStart: (cases) => send({ type: "start", cases }),
                onCase: (result, done, total) => send({ type: "case", result, done, total }),
              });
              send(res.ok ? { type: "done", run: res.run, ref: res.ref } : { type: "error", error: res.error });
            } catch (e) {
              send({ type: "error", error: e instanceof Error ? e.message : String(e) });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "application/x-ndjson",
            // Proxies that buffer would defeat the whole point.
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
