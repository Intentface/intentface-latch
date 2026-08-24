/**
 * The streaming renderer: fold a run's `RenderEvent`s into ONE live Slack
 * message via the native streaming API, with tool calls as task cards.
 *
 *   First renderable event → `chat.startStream` (channels need
 *   `recipient_team_id`); text buffers and flushes as `appendStream` every
 *   ~500ms; tool-start/end and reasoning become `task_update` chunks (reasoning
 *   is ONE collapsed "Thinking" task — never streamed as raw text);
 *   finish → `stopStream` with any trailing text, an error section if the run
 *   failed, and an optional feedback row.
 *
 * Stop is two signals, either wins: `appendStream` throwing `stopped_by_user`
 * (the viewer pressed Slack's native Stop button on THIS message) and the
 * host-backed `shouldStop` poll (a stop that landed on another instance).
 * Stopping cancels the event iterator — the adapter's run keeps completing
 * server-side; we just stop rendering it.
 *
 * If `startStream` itself fails (surface doesn't support it, missing recipient,
 * restricted workspace) the whole turn degrades to the FALLBACK engine — one
 * `postMessage` edited in place at a gentler cadence (Slack guidance:
 * `chat.update` ≤ 1/3s), with a status line instead of task cards. Same
 * mechanic as the Telegram edit loop.
 *
 * The streamed message holds up to `maxStreamedChars`; anything past it lands
 * in a follow-up message of native `markdown` blocks, so a long answer is
 * never silently truncated.
 */

import type { RenderEvent } from "../types.js";
import { SlackApiError, type SlackClient, type StreamChunk } from "./api.js";
import { errorBlocks, feedbackActions, markdownBlocks, notificationText } from "./blocks.js";

export interface SlackStreamOptions {
  api: Pick<SlackClient, "startStream" | "appendStream" | "stopStream" | "postMessage" | "update">;
  channel: string;
  /** Thread to render into; omit for an un-threaded DM reply. */
  threadTs?: string;
  /** REQUIRED by Slack to stream in a channel; harmless in a DM. */
  recipientTeamId?: string;
  recipientUserId?: string;
  /** Cross-instance stop flag (host-backed); polled once per flush tick. */
  shouldStop?: () => Promise<boolean>;
  /**
   * Called once, when the engine is decided — `stream`, or `fallback` with
   * Slack's refusal code/detail. Hosts surface it (binding health) so a bot
   * stuck in post+update mode is diagnosable without log spelunking.
   */
  onStreamMode?: (info: {
    mode: "stream" | "fallback";
    code?: string;
    detail?: string;
  }) => void | Promise<void>;
  /**
   * Best-effort free-text status next to the bot's name ("is thinking…",
   * "is using web_search…"). Renders in assistant/DM surfaces only; the host
   * wires it to the LEGACY assistant.threads.setStatus (free text has no
   * agents.sessions equivalent) — revisit before Slack's Feb 2027 sunset.
   */
  setStatus?: (text: string) => void | Promise<void>;
  /** Append the native 👍/👎 row to the final message. */
  feedback?: boolean;
  /** `postMessage` identity for the fallback engine (needs chat:write.customize). */
  identity?: { username?: string; icon_emoji?: string };
  flushIntervalMs?: number;
  fallbackUpdateIntervalMs?: number;
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

export async function renderSlackStream(
  events: AsyncIterable<RenderEvent>,
  opts: SlackStreamOptions,
): Promise<SlackStreamResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const fallbackInterval = opts.fallbackUpdateIntervalMs ?? 3000;
  const maxStreamed = opts.maxStreamedChars ?? MAX_APPEND_CHARS;
  let flushInterval = opts.flushIntervalMs ?? 500;

  let mode: SlackStreamResult["mode"] = "none";
  let text = ""; // everything the model said
  let streamedChars = 0; // how much of it the streamed message holds
  let pendingText = ""; // accumulated, not yet flushed
  let pendingChunks: StreamChunk[] = [];
  let ts: string | undefined;
  let statusLine = ""; // fallback engine only
  let lastRendered = ""; // fallback engine dedupe
  let errorMessage: string | undefined;
  let stopped = false;
  let reasoningOpen = false;
  let lastFlushAt = 0;
  let flushDue = false; // tool/reasoning transitions force the next flush

  const threadArgs = opts.threadTs ? { thread_ts: opts.threadTs } : {};

  /** Close the collapsed "Thinking" task the moment something visible happens. */
  function closeReasoning() {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    pendingChunks.push(taskChunk(REASONING_TASK_ID, "Thinking", "complete"));
  }

  const reportMode = (info: { mode: "stream" | "fallback"; code?: string; detail?: string }) => {
    void Promise.resolve(opts.onStreamMode?.(info)).catch(() => {});
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
      reportMode({ mode: "stream" });
    } catch (e) {
      if (isStoppedByUser(e)) {
        stopped = true;
        return;
      }
      console.error("[slack] startStream unavailable — falling back to post+update:", e);
      mode = "fallback";
      const err = e instanceof SlackApiError ? e : undefined;
      reportMode({
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

  /** Fallback-mode flush: one message, edited in place, status line inline. */
  async function flushFallback(final: boolean): Promise<void> {
    let body = text;
    if (!final && statusLine) body += `\n\n⏳ ${statusLine}`;
    if (!body.trim() && !final) return;
    if (body === lastRendered && !final) return;
    const blocks = markdownBlocks(body).slice(0, 8);
    if (final) {
      if (errorMessage) blocks.push(...errorBlocks(errorMessage));
      if (opts.feedback) blocks.push(feedbackActions());
    }
    try {
      if (ts === undefined) {
        const r = await opts.api.postMessage({
          channel: opts.channel,
          ...threadArgs,
          blocks,
          text: notificationText(body),
          ...(opts.identity ?? {}),
        });
        ts = r.ts;
      } else {
        await opts.api.update({ channel: opts.channel, ts, blocks, text: notificationText(body) });
      }
      lastRendered = body;
      lastFlushAt = now();
      pendingText = "";
      pendingChunks = [];
    } catch (e) {
      if (final) throw e;
      console.error("[slack] fallback update failed (will retry on next flush):", e);
    }
  }

  async function maybeFlush(): Promise<void> {
    const interval = mode === "fallback" ? fallbackInterval : flushInterval;
    const due = flushDue || now() - lastFlushAt >= interval;
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
    if (mode === "stream") await flushStream();
    else await flushFallback(false);
  }

  for await (const ev of events) {
    switch (ev.type) {
      case "text-delta":
        closeReasoning();
        text += ev.text;
        pendingText += ev.text;
        statusLine = "";
        break;
      case "reasoning-delta":
        // Never render reasoning text — one collapsed task tells the story.
        if (!reasoningOpen) {
          reasoningOpen = true;
          pendingChunks.push(taskChunk(REASONING_TASK_ID, "Thinking", "in_progress"));
          statusLine = "Thinking…";
          status("is thinking…");
          flushDue = true;
        }
        break;
      case "tool-start":
        closeReasoning();
        pendingChunks.push(taskChunk(ev.toolCallId, `Using ${ev.toolName}`, "in_progress"));
        statusLine = `Running ${ev.toolName}…`;
        status(`is using ${ev.toolName}…`);
        flushDue = true;
        break;
      case "tool-end":
        pendingChunks.push(
          taskChunk(ev.toolCallId, `Using ${ev.toolName}`, ev.error ? "error" : "complete"),
        );
        statusLine = "";
        status("");
        flushDue = true;
        break;
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
          ...(opts.identity ?? {}),
        });
        return { text, errorMessage, ts: r.ts, mode: "none" };
      }
      const res: SlackStreamResult = { text, mode: "none" };
      if (errorMessage !== undefined) res.errorMessage = errorMessage;
      return res;
    }
  }

  if (modeNow() === "fallback") {
    await flushFallback(true);
    const res: SlackStreamResult = { text, mode };
    if (ts !== undefined) res.ts = ts;
    if (errorMessage !== undefined) res.errorMessage = errorMessage;
    return res;
  }

  // Streamed mode: close with trailing text (within budget), error, feedback.
  const room = Math.max(0, maxStreamed - streamedChars);
  const tail = pendingText.slice(0, Math.min(room, MAX_APPEND_CHARS));
  const overflow = pendingText.slice(tail.length);
  const finalBlocks: unknown[] = [];
  if (errorMessage) finalBlocks.push(...errorBlocks(errorMessage));
  if (opts.feedback) finalBlocks.push(feedbackActions());

  const stopArgs = {
    channel: opts.channel,
    ts: ts as string,
    ...(tail ? { markdown_text: tail } : {}),
    ...(pendingChunks.length ? { chunks: pendingChunks } : {}),
    ...(finalBlocks.length ? { blocks: finalBlocks } : {}),
  };
  try {
    await opts.api.stopStream(stopArgs);
  } catch (e) {
    if (!isStoppedByUser(e)) {
      // One more try after a beat, then leave the stream to Slack's own
      // timeout — the content is safe, the overflow path below still runs.
      await sleep(1000);
      await opts.api.stopStream(stopArgs).catch((e2) => {
        console.error("[slack] stopStream failed twice; stream left to expire:", e2);
      });
    }
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
      ...(opts.identity ?? {}),
    });
    overflowTs.push(r.ts);
  }

  const res: SlackStreamResult = { text, mode };
  if (ts !== undefined) res.ts = ts;
  if (errorMessage !== undefined) res.errorMessage = errorMessage;
  if (overflowTs.length) res.overflowTs = overflowTs;
  return res;
}
