/**
 * Speech-to-text via ElevenLabs scribe_v2, shared by the web mic route
 * (/api/transcribe) and channel voice messages (Telegram `transcribe` hook).
 *
 * scribe_v2, chosen over gpt-4o-transcribe in a head-to-head: accuracy tied on
 * Finnish + English, but scribe keeps strict verbatim (fillers preserved —
 * hesitation is signal for an interview agent), tags audio events like
 * (laughs), and takes `keyterms` to bias proper nouns. Language is
 * auto-detected per clip (a single language_code would break bilingual use).
 * Called via raw fetch — one endpoint, no SDK dependency.
 */
const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_MODEL = "scribe_v2";

/** Transcribe one audio clip. Throws on any failure (unconfigured key, upstream error, empty result). */
export async function transcribeAudio(input: {
  audio: Blob;
  filename?: string;
  /** Proper nouns to bias recognition toward (e.g. the speaker's name). */
  keyterms?: string[];
}): Promise<string> {
  const apiKey = process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) throw new Error("transcription is not configured (ELEVEN_LABS_API_KEY unset)");

  const scribe = new FormData();
  scribe.append("model_id", SCRIBE_MODEL);
  scribe.append("file", input.audio, input.filename ?? "voice-message");
  scribe.append("tag_audio_events", "true"); // (laughs) etc. — delivery nuance
  scribe.append("temperature", "0");
  for (const term of input.keyterms ?? []) scribe.append("keyterms", term);

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
      throw new Error(`transcription failed (upstream ${res.status})`);
    }
    const result = (await res.json()) as { text?: string };
    const text = result.text?.trim();
    if (!text) throw new Error("transcription came back empty");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
