import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth";
import { transcribeAudio } from "@/lib/transcribe";

/**
 * Voice-message transcription. The client records audio (mic → MediaRecorder),
 * POSTs it here as multipart/form-data, and sends the returned transcript as a
 * normal text chat message — the audio itself is discarded, never stored.
 *
 * The ElevenLabs call itself lives in lib/transcribe.ts, shared with the
 * Telegram channel's voice-message hook.
 */

// Vercel serverless caps request bodies at ~4.5MB; the client records Opus/AAC
// at 48kbps so a full 10-minute message stays under this (~3.6MB).
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return json(401, { error: "unauthorized" });

        // After auth — unauthenticated callers shouldn't learn deployment config.
        if (!process.env.ELEVEN_LABS_API_KEY) {
          return json(502, { error: "transcription is not configured" });
        }
        // Keyterm bias: the speaker's own name and org (from their email
        // domain) — the proper nouns ASR most often mangles.
        const orgWord = session.user.email?.split("@")[1]?.split(".")[0];
        const keyterms = [
          session.user.name,
          orgWord && orgWord.length > 2 ? orgWord[0].toUpperCase() + orgWord.slice(1) : undefined,
        ].filter((t): t is string => !!t);

        const form = await request.formData().catch(() => null);
        const audio = form?.get("audio");
        if (!(audio instanceof File) || audio.size === 0) {
          return json(400, { error: "missing audio" });
        }
        if (audio.size > MAX_AUDIO_BYTES) {
          return json(400, { error: "recording too large — try a shorter message" });
        }
        const durationMs = Number(form?.get("durationMs") ?? 0);
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
          return json(400, { error: "invalid duration" });
        }

        try {
          const text = await transcribeAudio({ audio, keyterms });
          return json(200, { text, durationMs });
        } catch (e) {
          console.error("transcription failed:", e);
          return json(502, { error: "transcription failed — try again" });
        }
      },
    },
  },
});
