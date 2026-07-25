import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth";

/**
 * Voice-message transcription. The client records audio (mic → MediaRecorder),
 * POSTs it here as multipart/form-data, and sends the returned transcript as a
 * normal text chat message — the audio itself is discarded, never stored.
 *
 * ElevenLabs scribe_v2, chosen over gpt-4o-transcribe in a head-to-head:
 * accuracy tied on Finnish + English, but scribe keeps strict verbatim
 * (fillers preserved — hesitation is signal for an interview agent), tags
 * audio events like (laughs), and takes `keyterms` to bias proper nouns.
 * Language is auto-detected per clip (a single language_code would break
 * bilingual use). Called via raw fetch — one endpoint, no SDK dependency.
 */
const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_MODEL = "scribe_v2";

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
        const apiKey = process.env.ELEVEN_LABS_API_KEY;
        if (!apiKey) return json(502, { error: "transcription is not configured" });

        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return json(401, { error: "unauthorized" });
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

        const scribe = new FormData();
        scribe.append("model_id", SCRIBE_MODEL);
        scribe.append("file", audio, "voice-message");
        scribe.append("tag_audio_events", "true"); // (laughs) etc. — delivery nuance
        scribe.append("temperature", "0");
        for (const term of keyterms) scribe.append("keyterms", term);

        // Bound the upstream call — a stalled ElevenLabs response must fail the
        // request, not hang the serverless invocation until the platform timeout.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          const res = await fetch(SCRIBE_URL, {
            method: "POST",
            headers: { "xi-api-key": apiKey },
            body: scribe,
            signal: controller.signal,
          });
          if (!res.ok) {
            console.error("transcription failed:", res.status, (await res.text()).slice(0, 300));
            return json(502, { error: "transcription failed — try again" });
          }
          const result = (await res.json()) as { text?: string };
          const text = result.text?.trim();
          if (!text) return json(502, { error: "transcription came back empty" });
          return json(200, { text, durationMs });
        } catch (e) {
          console.error("transcription failed:", e);
          return json(502, { error: "transcription failed — try again" });
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  },
});
