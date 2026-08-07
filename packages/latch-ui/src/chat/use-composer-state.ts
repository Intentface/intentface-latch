import type { ChatStatus, UIMessage } from "ai";
import { useRef } from "react";
import type { ToolLabels, ToolPart } from "./message-utils.js";
import type { AskUserInput, AskUserQuestion } from "./ask-user.js";
import type { SecretRequestInput } from "./secret-request.js";

/** A single in-flight step shown in the composer's loading queue. */
export type ComposerStepItem = {
  key: string;
  label: string;
  kind: "thinking" | "tool";
};

/**
 * What the composer should show: the normal input (`idle`), an animated step
 * queue while the agent works (`active`), a clarification questionnaire
 * (`ask-user`, when an `askUser` tool call is awaiting input), or a credential
 * form (`secret-request`, when a `request_secret` tool call is awaiting input).
 */
export type ComposerPanelState =
  | { type: "idle" }
  | { type: "active"; steps: ComposerStepItem[] }
  | { type: "ask-user"; toolCallId: string; questions: AskUserQuestion[] }
  | { type: "secret-request"; toolCallId: string; request: SecretRequestInput };

const THINKING: ComposerStepItem = { key: "thinking", label: "Thinking…", kind: "thinking" };

const stateEqual = (a: ComposerPanelState, b: ComposerPanelState): boolean => {
  if (a.type !== b.type) return false;
  if (a.type === "idle") return true;
  if (a.type === "ask-user" && b.type === "ask-user") return a.toolCallId === b.toolCallId;
  if (a.type === "secret-request" && b.type === "secret-request")
    return a.toolCallId === b.toolCallId;
  if (a.type === "active" && b.type === "active") {
    if (a.steps.length !== b.steps.length) return false;
    return a.steps.every((s, i) => s.key === b.steps[i].key && s.label === b.steps[i].label);
  }
  return false;
};

const lastHeader = (text: string): string | undefined =>
  text
    .match(/\*\*(.+?)\*\*/g)
    ?.map((h) => h.replace(/\*\*/g, ""))
    .at(-1);

const deriveState = (
  messages: UIMessage[],
  status: ChatStatus,
  labels?: ToolLabels,
): ComposerPanelState => {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  // An askUser tool awaiting input — detect regardless of status (the chat goes
  // "ready" while the tool waits for the user's answer).
  if ((status === "ready" || status === "streaming") && lastAssistant) {
    const ask = lastAssistant.parts.find(
      (p): p is ToolPart =>
        p.type === "tool-askUser" && "state" in p && p.state === "input-available",
    );
    if (ask) {
      const input = ask.input as AskUserInput | undefined;
      return { type: "ask-user", toolCallId: ask.toolCallId, questions: input?.questions ?? [] };
    }

    // Same deal for a paused credential form.
    const secret = lastAssistant.parts.find(
      (p): p is ToolPart =>
        p.type === "tool-request_secret" && "state" in p && p.state === "input-available",
    );
    if (secret) {
      const input = secret.input as SecretRequestInput | undefined;
      if (input?.fields?.length) {
        return { type: "secret-request", toolCallId: secret.toolCallId, request: input };
      }
    }
  }

  if (status === "ready" || status === "error") return { type: "idle" };
  if (status === "submitted" || !lastAssistant) return { type: "active", steps: [THINKING] };

  // status === "streaming" — scan the in-flight assistant message.
  const { parts } = lastAssistant;

  const toolParts = parts.filter(
    (p): p is ToolPart =>
      p.type !== "tool-askUser" &&
      p.type !== "tool-request_secret" &&
      p.type.startsWith("tool-") &&
      "state" in p &&
      (p.state === "input-streaming" ||
        p.state === "input-available" ||
        p.state === "output-available"),
  );

  if (toolParts.length > 0) {
    const hasActive = toolParts.some(
      (p) => p.state === "input-streaming" || p.state === "input-available",
    );
    // Keep showing the tool chain until text output begins (avoids flicker).
    const hasTextAfterTools = !hasActive && parts.at(-1)?.type === "text";
    if (!hasTextAfterTools) {
      const steps: ComposerStepItem[] = [];
      if (parts.some((p) => p.type === "reasoning")) {
        steps.push({ key: "reasoning", label: "Thinking", kind: "thinking" });
      }
      for (const part of toolParts) {
        const name = part.type.replace("tool-", "");
        const input = (part.input as Record<string, unknown>) ?? {};
        const label = labels?.[name]?.active?.(input) ?? `Running ${name}`;
        steps.push({ key: part.toolCallId, label, kind: "tool" });
      }
      return { type: "active", steps };
    }
  }

  const lastPart = parts.at(-1);
  if (lastPart?.type === "reasoning") {
    const text = "text" in lastPart ? (lastPart.text as string) : "";
    return {
      type: "active",
      steps: [{ key: "reasoning", label: lastHeader(text) ?? "Thinking…", kind: "thinking" }],
    };
  }

  // Last part is visible text → the answer is streaming inline → idle composer.
  return { type: "idle" };
};

/**
 * Derives the composer panel state from the chat messages + status, memoized so
 * streaming chunks that don't change the visible steps don't churn refs.
 */
export const useComposerState = (
  messages: UIMessage[],
  status: ChatStatus,
  labels?: ToolLabels,
): ComposerPanelState => {
  const prev = useRef<ComposerPanelState>({ type: "idle" });
  const next = deriveState(messages, status, labels);
  if (stateEqual(prev.current, next)) return prev.current;
  prev.current = next;
  return next;
};
