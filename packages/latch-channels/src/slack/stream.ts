/**
 * The streaming renderer: fold a run's `RenderEvent`s into ONE live Slack
 * message via the native streaming API, with tool calls as task cards.
 *
 *   First renderable event → `chat.startStream` (channels need
 *   `recipient_team_id`); text buffers and flushes as `appendStream` every
 *   ~500ms; tool-start/end and reasoning become `task_update` chunks (reasoning
 *   is ONE collapsed "Thinking" task — never streamed as raw text);
 *   finish → `stopStream` with any trailing text and an error section if the
 *   run failed.
 *
 * Stop is two signals, either wins: `appendStream` throwing `stopped_by_user`
 * (the viewer pressed Slack's native Stop button on THIS message) and the
 * host-backed `shouldStop` poll (a stop that landed on another instance).
 * Stopping cancels the event iterator — the adapter's run keeps completing
 * server-side; we just stop rendering it.
 *
 * If `startStream` itself fails (surface doesn't support it, missing recipient,
 * restricted workspace) or the stream dies mid-turn, the turn degrades to the
 * FALLBACK engine: buffer everything and post the finished answer ONCE at the
 * end. Never edit-to-mimic — a message that looks like it's streaming must BE
 * streaming. A stream that died mid-turn is deleted (its stranded task cards
 * would otherwise render as ⚠️ forever) and the full text arrives in the
 * final post instead.
 *
 * The streamed message holds up to `maxStreamedChars`; anything past it lands
 * in a follow-up message of native `markdown` blocks, so a long answer is
 * never silently truncated.
 */

import type { RenderEvent } from "../types.js";
import { SlackApiError, type SlackClient, type StreamChunk } from "./api.js";
import { errorBlocks, markdownBlocks, notificationText } from "./blocks.js";

export interface SlackStreamOptions {
  api: Pick<
    SlackClient,
    "startStream" | "appendStream" | "stopStream" | "postMessage" | "deleteMessage"
  >;
  channel: string;
  /** Thread to render into; omit for an un-threaded DM reply. */
  threadTs?: string;
  /** REQUIRED by Slack to stream in a channel; harmless in a DM. */
  recipientTeamId?: string;
  recipientUserId?: string;
  /** Cross-instance stop flag (host-backed); polled once per flush tick. */
  shouldStop?: () => Promise<boolean>;
  /**
   * Called when the engine is decided — `stream`, or `fallback` with Slack's
   * refusal code/detail — and AGAIN if a live stream dies mid-turn (the turn
   * then finishes as `fallback`). Hosts surface the last value (binding
   * health) so a degraded bot is diagnosable without log spelunking.
   */
  onStreamMode?: (info: {
    mode: "stream" | "fallback";
    code?: string;
    detail?: string;
  }) => void | Promise<void>;
  /**
   * Title for tool events whose stream carries no name — an approval RESUME
   * only replays the tool's output event (the call happened in the parked
   * turn), so the name lookup comes back empty and the task card would read
   * "Using ". Callers that know the resumed tool pass it here.
   */
  resumedToolName?: string;
  /**
   * Best-effort free-text status next to the bot's name ("is thinking…",
   * "is using web_search…"). Renders in assistant/DM surfaces only; the host
   * wires it to the LEGACY assistant.threads.setStatus (free text has no
   * agents.sessions equivalent) — revisit before Slack's Feb 2027 sunset.
   */
  setStatus?: (text: string) => void | Promise<void>;
  flushIntervalMs?: number;
  /** Text budget of the streamed message itself; the rest overflows. */
  maxStreamedChars?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SlackStreamResult {
  /** The full accumulated answer text (pre-overflow-split). */
  text: string;
  errorMessage?: string;
  /** ts of the streamed (or fallback) message, once one exists. */
  ts?: string;
  /** The viewer stopped the response. */
  stopped?: boolean;
  /** Which engine rendered the turn. `none` = nothing was ever posted. */
  mode: "stream" | "fallback" | "none";
  /** Follow-up messages posted for text past the streamed budget. */
  overflowTs?: string[];
}

const MAX_APPEND_CHARS = 12_000; // per-call markdown_text cap
const TASK_TITLE_LIMIT = 250; // Slack caps task chunks at 256 chars
const REASONING_TASK_ID = "reasoning";
const STOPPED_NOTICE = "\n\n_Stopped._";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function taskChunk(
  id: string,
  title: string,
  status: "in_progress" | "complete" | "error",
): StreamChunk {
  return { type: "task_update", id, title: clip(title, TASK_TITLE_LIMIT), status };
}

/** True when this error means "the viewer pressed Stop", not "the call failed". */
function isStoppedByUser(e: unknown): boolean {
  return e instanceof SlackApiError && e.code === "stopped_by_user";
}

/** The streamed message is gone or already finalized — appends can never land. */
function isDeadStream(e: unknown): boolean {
  return (
    e instanceof SlackApiError &&
    (e.code === "message_not_in_streaming_state" || e.code === "message_not_found")
  );
}

export async function renderSlackStream(
  events: AsyncIterable<RenderEvent>,
  opts: SlackStreamOptions,
): Promise<SlackStreamResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const maxStreamed = opts.maxStreamedChars ?? MAX_APPEND_CHARS;
  let flushInterval = opts.flushIntervalMs ?? 500;

  let mode: SlackStreamResult["mode"] = "none";
  let text = ""; // everything the model said
  let streamedChars = 0; // how much of it the streamed message holds
  let pendingText = ""; // accumulated, not yet flushed
  let pendingChunks: StreamChunk[] = [];
  let ts: string | undefined;
  let errorMessage: string | undefined;
  let stopped = false;
  let reasoningOpen = false;
  let lastFlushAt = 0;
  let flushDue = false; // tool/reasoning transitions force the next flush
  // Tasks still in_progress. A stream closed with open tasks renders them as
  // warnings (⚠️) — a parked approval must settle its card instead.
  const openTasks = new Map<string, string>();

  const threadArgs = opts.threadTs ? { thread_ts: opts.threadTs } : {};

  function queueTask(id: string, title: string, st: "in_progress" | "complete" | "error") {
    pendingChunks.push(taskChunk(id, title, st));
    if (st === "in_progress") openTasks.set(id, title);
    else openTasks.delete(id);
  }

  /** Settle whatever is still open (approval-parked turns end mid-task). */
  function settleOpenTasks() {
    for (const [id, title] of openTasks) pendingChunks.push(taskChunk(id, title, "complete"));
    openTasks.clear();
  }

  /** Close the collapsed "Thinking" task the moment something visible happens. */
  function closeReasoning() {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    queueTask(REASONING_TASK_ID, "Thinking", "complete");
  }

  // AWAITED, not fire-and-forget: on serverless the platform's waitUntil
  // tracks the turn promise — a detached telemetry write can lose the race
  // with function freeze on a short turn.
  const reportMode = async (info: {
    mode: "stream" | "fallback";
    code?: string;
    detail?: string;
  }) => {
    try {
      await opts.onStreamMode?.(info);
    } catch (e) {
      console.error("[slack] stream-mode telemetry failed:", e);
    }
  };
  const status = (text: string) => {
    void Promise.resolve(opts.setStatus?.(text)).catch(() => {});
  };

  async function start(): Promise<void> {
    try {
      const r = await opts.api.startStream({
        channel: opts.channel,
        ...threadArgs,
        ...(opts.recipientTeamId ? { recipient_team_id: opts.recipientTeamId } : {}),
        ...(opts.recipientUserId ? { recipient_user_id: opts.recipientUserId } : {}),
      });
      ts = r.ts;
      mode = "stream";
      await reportMode({ mode: "stream" });
    } catch (e) {
      if (isStoppedByUser(e)) {
        stopped = true;
        return;
      }
      console.error("[slack] startStream unavailable — will post the answer at finish:", e);
      mode = "fallback";
      const err = e instanceof SlackApiError ? e : undefined;
      await reportMode({
        mode: "fallback",
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.detail ? { detail: err.detail } : {}),
      });
    }
  }

  /** Streamed-mode flush: send pending text (within budget) + queued chunks. */
  async function flushStream(): Promise<void> {
    if (!ts) return;
    // Respect the streamed-message budget; the remainder overflows at finish.
    const room = Math.max(0, maxStreamed - streamedChars);
    const sendText = pendingText.slice(0, Math.min(room, MAX_APPEND_CHARS));
    const chunks = pendingChunks;
    if (!sendText && !chunks.length) return;
    try {
      await opts.api.appendStream({
        channel: opts.channel,
        ts,
        ...(sendText ? { markdown_text: sendText } : {}),
        ...(chunks.length ? { chunks } : {}),
      });
      streamedChars += sendText.length;
      // Drop exactly what went out; anything the budget refused stays pending
      // so the finish-time overflow message still carries it.
      pendingText = pendingText.slice(sendText.length);
      pendingChunks = [];
      lastFlushAt = now();
    } catch (e) {
      if (isStoppedByUser(e)) {
        stopped = true;
        return;
      }
      if (isDeadStream(e)) {
        // Slack expires an idle stream (e.g. while the model thinks after a
        // tool result). Retrying into a corpse loses the whole answer — flip
        // to the fallback engine, which posts the FULL text once at finish.
        // The corpse is deleted: it can never be finalized, so its open task
        // cards would render as ⚠️ forever, and its partial text would
        // duplicate the final post's.
        console.error("[slack] stream expired mid-turn — will post the answer at finish:", e);
        const corpse = ts;
        mode = "fallback";
        ts = undefined;
        await reportMode({ mode: "fallback", code: (e as SlackApiError).code ?? "dead_stream" });
        if (corpse) {
          await opts.api
            .deleteMessage({ channel: opts.channel, ts: corpse })
            .catch((e2) => console.error("[slack] dead-stream cleanup failed:", e2));
        }
        return;
      }
      if (e instanceof SlackApiError && e.status === 429) {
        // The client already honored one Retry-After; be gentler for the rest
        // of the turn. Nothing is lost — the buffer coalesces.
        flushInterval = Math.min(flushInterval * 2, 8000);
        console.error("[slack] appendStream rate-limited; slowing to", flushInterval, "ms");
        return;
      }
      console.error("[slack] appendStream failed (will retry on next flush):", e);
    }
  }

  /**
   * Fallback engine: nothing renders mid-turn — the finished answer posts
   * ONCE here. No chat.update, ever: a message that looks like it's
   * streaming must BE streaming.
   */
  async function postFallbackFinal(): Promise<void> {
    if (!text.trim() && !errorMessage) return;
    const all = markdownBlocks(text);
    const blocks = all.slice(0, 8);
    if (all.length > blocks.length) {
      blocks.push({
        type: "markdown",
        text: "_Answer truncated for Slack — the full turn is available in Latch._",
      });
    }
    if (errorMessage) blocks.push(...errorBlocks(errorMessage));
    const r = await opts.api.postMessage({
      channel: opts.channel,
      ...threadArgs,
      blocks,
      text: notificationText(text || errorMessage || "Answer"),
    });
    ts = r.ts;
  }

  async function maybeFlush(): Promise<void> {
    const due = flushDue || now() - lastFlushAt >= flushInterval;
    const hasWork = pendingText.length > 0 || pendingChunks.length > 0;
    if (!hasWork || (!due && mode !== "none")) return;

    if (mode === "none") {
      // Create the message promptly on first content; then throttle.
      await start();
      if (stopped) return;
    }
    flushDue = false;
    if (opts.shouldStop && (await opts.shouldStop())) {
      stopped = true;
      return;
    }
    if (mode === "stream") {
      await flushStream();
    } else {
      // Fallback: nothing renders mid-turn. Mark the tick so the stop poll
      // above keeps its cadence instead of running on every event.
      lastFlushAt = now();
    }
  }

  for await (const ev of events) {
    switch (ev.type) {
      case "text-delta":
        closeReasoning();
        text += ev.text;
        pendingText += ev.text;
        break;
      case "reasoning-delta":
        // Never render reasoning text — one collapsed task tells the story.
        if (!reasoningOpen) {
          reasoningOpen = true;
          queueTask(REASONING_TASK_ID, "Thinking", "in_progress");
          status("is thinking…");
          flushDue = true;
        }
        break;
      case "tool-start": {
        closeReasoning();
        const name = ev.toolName || opts.resumedToolName || "tool";
        queueTask(ev.toolCallId, `Using ${name}`, "in_progress");
        status(`is using ${name}…`);
        flushDue = true;
        break;
      }
      case "tool-end": {
        const name = ev.toolName || opts.resumedToolName || "tool";
        queueTask(ev.toolCallId, `Using ${name}`, ev.error ? "error" : "complete");
        status("");
        flushDue = true;
        break;
      }
      case "error":
        errorMessage = ev.message;
        continue;
      default:
        continue;
    }
    await maybeFlush();
    if (stopped) break;
  }

  // ── Finalize ───────────────────────────────────────────────────────────────

  closeReasoning();
  settleOpenTasks();
  status("");

  // `mode` is only ever assigned inside the closures above; read it through a
  // function so control-flow narrowing doesn't freeze it at the initial "none".
  const modeNow = (): SlackStreamResult["mode"] => mode;

  if (stopped) {
    if (modeNow() === "stream" && ts) {
      await opts.api
        .stopStream({ channel: opts.channel, ts, markdown_text: STOPPED_NOTICE })
        .catch(() => {
          /* the stop already landed user-side; closing is best-effort */
        });
    }
    const res: SlackStreamResult = { text, mode, stopped: true };
    if (ts !== undefined) res.ts = ts;
    if (errorMessage !== undefined) res.errorMessage = errorMessage;
    return res;
  }

  // A run that produced neither text nor tool activity (approval-parked runs
  // do this) never opened a message — only surface a hard error.
  if (modeNow() === "none") {
    if (pendingText || pendingChunks.length) await start();
    if (modeNow() === "none") {
      if (errorMessage) {
        const r = await opts.api.postMessage({
          channel: opts.channel,
          ...threadArgs,
          blocks: errorBlocks(errorMessage),
          text: notificationText(errorMessage),
        });
        return { text, errorMessage, ts: r.ts, mode: "none" };
      }
      const res: SlackStreamResult = { text, mode: "none" };
      if (errorMessage !== undefined) res.errorMessage = errorMessage;
      return res;
    }
  }

  if (modeNow() === "fallback") {
    // Honor a stop that landed while nothing was rendering.
    if (opts.shouldStop && (await opts.shouldStop())) {
      const res: SlackStreamResult = { text, mode, stopped: true };
      if (errorMessage !== undefined) res.errorMessage = errorMessage;
      return res;
    }
    await postFallbackFinal();
    const res: SlackStreamResult = { text, mode };
    if (ts !== undefined) res.ts = ts;
    if (errorMessage !== undefined) res.errorMessage = errorMessage;
    return res;
  }

  // Streamed mode: close with trailing text (within budget) and error.
  const room = Math.max(0, maxStreamed - streamedChars);
  const tail = pendingText.slice(0, Math.min(room, MAX_APPEND_CHARS));
  const overflow = pendingText.slice(tail.length);
  const finalBlocks: unknown[] = [];
  if (errorMessage) finalBlocks.push(...errorBlocks(errorMessage));

  const stopArgs = {
    channel: opts.channel,
    ts: ts as string,
    ...(tail ? { markdown_text: tail } : {}),
    ...(pendingChunks.length ? { chunks: pendingChunks } : {}),
    ...(finalBlocks.length ? { blocks: finalBlocks } : {}),
  };
  let tailDelivered = false;
  try {
    await opts.api.stopStream(stopArgs);
    tailDelivered = true;
  } catch (e) {
    if (isStoppedByUser(e)) {
      tailDelivered = true; // the viewer cut it off — nothing owed
    } else if (!isDeadStream(e)) {
      // One more try after a beat for transient failures.
      await sleep(1000);
      tailDelivered = await opts.api.stopStream(stopArgs).then(
        () => true,
        (e2: unknown) => {
          // The viewer stopping between the two attempts is a delivery
          // verdict, not a failure — never post the tail they refused.
          if (isStoppedByUser(e2)) return true;
          console.error("[slack] stopStream failed twice:", e2);
          return false;
        },
      );
    } else {
      console.error("[slack] stream already expired at close:", e);
    }
  }
  // The tail (text the stream never delivered) must NEVER vanish: if the
  // close failed, post it as a regular message. Degraded, but it arrives.
  if (!tailDelivered && (tail || finalBlocks.length)) {
    await opts.api
      .postMessage({
        channel: opts.channel,
        ...threadArgs,
        blocks: [...(tail ? markdownBlocks(tail) : []), ...finalBlocks],
        text: notificationText(tail || errorMessage || "Answer"),
      })
      .catch((e) => console.error("[slack] tail recovery post failed:", e));
  }

  const overflowTs: string[] = [];
  if (overflow) {
    const blocks = markdownBlocks(overflow);
    const capped = blocks.slice(0, 8);
    if (blocks.length > capped.length) {
      capped.push({
        type: "markdown",
        text: "_Answer truncated for Slack — the full turn is available in Latch._",
      });
    }
    const r = await opts.api.postMessage({
      channel: opts.channel,
      ...threadArgs,
      blocks: capped,
      text: notificationText(overflow),
    });
    overflowTs.push(r.ts);
  }

  const res: SlackStreamResult = { text, mode };
  if (ts !== undefined) res.ts = ts;
  if (errorMessage !== undefined) res.errorMessage = errorMessage;
  if (overflowTs.length) res.overflowTs = overflowTs;
  return res;
}
