import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth";

/** Catch-all → better-auth's fetch handler (/api/auth/sign-in, /organization, …). */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
