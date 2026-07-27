import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Mic, RotateCcw, X } from "lucide-react";
import { cn, IconButton } from "@intentface/latch-ui";

/**
 * Voice-message capture for the composer: tap the mic to record, tap ✓ to
 * stop — the audio is POSTed to `/api/transcribe` and the transcript handed to
 * `onTranscribed`, which sends it as a normal text chat message. The audio is
 * never persisted; on transcription failure the blob is kept in memory for a
 * one-tap retry.
 *
 * Recording is deliberately allowed while the agent is still responding —
 * capture is local; the host decides when the transcript can actually be sent.
 */
const MAX_DURATION_MS = 10 * 60 * 1000;
const WARN_REMAINING_MS = 60 * 1000;

// Preferred first; Safari lacks webm/opus and records AAC in mp4 instead. The
// 48kbps audio bitrate keeps a full 10-minute message ≤ ~3.6MB (under Vercel's
// ~4.5MB request-body cap) — lower rates measurably hurt transcription of
// proper nouns and non-English speech.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

type VoiceState =
  | { status: "idle" }
  // Mic requested (permission prompt / device opening) but not yet recording.
  | { status: "arming" }
  | { status: "recording"; elapsedMs: number }
  | { status: "transcribing" }
  | { status: "error"; message: string };

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function VoiceRecorder({
  disabled,
  onTranscribed,
}: {
  disabled?: boolean;
  onTranscribed: (text: string, durationMs: number) => void;
}) {
  const [state, setState] = useState<VoiceState>({ status: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const unmountedRef = useRef(false);
  // Kept after a failed transcription so retry doesn't require re-recording.
  const pendingRef = useRef<{ blob: Blob; durationMs: number } | null>(null);

  function cleanupRecorder() {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }

  useEffect(
    () => () => {
      unmountedRef.current = true;
      cleanupRecorder();
    },
    [],
  );

  async function start() {
    const s = stateRef.current.status;
    if (s !== "idle" && s !== "error") return; // ignore double-clicks / re-entry
    pendingRef.current = null;
    cancelledRef.current = false;
    // Instant feedback: the permission prompt / device open can take a while.
    setState({ status: "arming" });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!unmountedRef.current) {
        setState({ status: "error", message: "Microphone access was denied." });
      }
      return;
    }
    if (unmountedRef.current || cancelledRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      if (!unmountedRef.current) setState({ status: "idle" });
      return;
    }
    streamRef.current = stream;
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    // Only show the recording UI once capture has actually begun — the timer
    // then reflects real recorded time, not device-open latency.
    recorder.onstart = () => {
      startedAtRef.current = Date.now();
      setState({ status: "recording", elapsedMs: 0 });
      timerRef.current = setInterval(() => {
        const elapsedMs = Date.now() - startedAtRef.current;
        if (elapsedMs >= MAX_DURATION_MS) {
          stop(false); // auto-stop at the cap → transcribe + send
          return;
        }
        setState({ status: "recording", elapsedMs });
      }, 250);
    };
    recorder.onerror = () => {
      cleanupRecorder();
      setState({ status: "error", message: "Recording failed — try again." });
    };
    recorder.onstop = () => {
      const durationMs = Math.min(Date.now() - startedAtRef.current, MAX_DURATION_MS);
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const cancelled = cancelledRef.current;
      cleanupRecorder();
      if (cancelled || blob.size === 0) {
        setState({ status: "idle" });
        return;
      }
      void transcribe({ blob, durationMs });
    };

    try {
      recorder.start(1000);
    } catch {
      cleanupRecorder();
      setState({ status: "error", message: "Recording failed — try again." });
    }
  }

  /** Stop (or cancel) whatever is in flight — never throws, never gets stuck. */
  function stop(cancelled: boolean) {
    cancelledRef.current = cancelled;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      // Arming (mic not open yet) or a dead recorder: bail out cleanly.
      cleanupRecorder();
      setState({ status: "idle" });
      return;
    }
    try {
      recorder.stop(); // onstop handles the rest
    } catch {
      cleanupRecorder();
      setState({ status: cancelled ? "idle" : "error", message: "Recording failed — try again." });
    }
  }

  async function transcribe(pending: { blob: Blob; durationMs: number }) {
    pendingRef.current = pending;
    setState({ status: "transcribing" });
    const form = new FormData();
    form.append("audio", pending.blob, "voice-message");
    form.append("durationMs", String(Math.round(pending.durationMs)));
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (unmountedRef.current) return;
      if (!res.ok || !body?.text) {
        setState({ status: "error", message: body?.error ?? "Transcription failed — try again." });
        return;
      }
      pendingRef.current = null;
      setState({ status: "idle" });
      onTranscribed(body.text, pending.durationMs);
    } catch {
      if (!unmountedRef.current) {
        setState({ status: "error", message: "Transcription failed — try again." });
      }
    }
  }

  if (state.status === "recording") {
    const remainingMs = MAX_DURATION_MS - state.elapsedMs;
    const nearCap = remainingMs <= WARN_REMAINING_MS;
    return (
      <div className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-red-500" />
        <span className={cn("text-xs tabular-nums", nearCap ? "text-amber-600" : "text-ink-secondary")}>
          {nearCap ? `-${formatDuration(remainingMs)}` : formatDuration(state.elapsedMs)}
        </span>
        <IconButton type="button" variant="ghost" aria-label="Cancel recording" onClick={() => stop(true)}>
          <X />
        </IconButton>
        <IconButton type="button" variant="accent" aria-label="Stop and send" onClick={() => stop(false)}>
          <Check />
        </IconButton>
      </div>
    );
  }

  if (state.status === "transcribing") {
    return (
      <div className="text-ink-secondary flex items-center gap-1.5 text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        Transcribing…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="max-w-56 truncate text-xs text-red-500">{state.message}</span>
        {pendingRef.current && (
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Retry transcription"
            onClick={() => void transcribe(pendingRef.current!)}
          >
            <RotateCcw />
          </IconButton>
        )}
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Dismiss"
          onClick={() => {
            pendingRef.current = null;
            setState({ status: "idle" });
          }}
        >
          <X />
        </IconButton>
      </div>
    );
  }

  const arming = state.status === "arming";
  return (
    <IconButton
      type="button"
      variant="ghost"
      aria-label="Record voice message"
      disabled={disabled || arming}
      onClick={() => void start()}
    >
      {arming ? <Loader2 className="animate-spin" /> : <Mic />}
    </IconButton>
  );
}
