/**
 * The composer.
 *
 * `ChatInput` is the thin bridge that reads the message stream; everything below
 * it is memoized, so a token arriving never re-renders the editor. The panel
 * above the field is where the agent's pauses surface: an ask-user questionnaire
 * (driven by the composer's own flow) or a credential form.
 */

import type { AttachmentItem } from "@intentface/chat/attachments"
import type {
  ComposerAnswerEntry,
  ComposerSubmitData,
} from "@intentface/chat/composer"
import { memo, useEffect, useMemo, useState } from "react"
import { Composer } from "@/components/ai/composer"
import type { ComposerCommandsMap } from "@/components/ai/composer"
import { SecretRequestForm } from "@/components/chat/secret-request-form"
import type { ChatPanelState } from "@/components/chat/use-panel-state"
import { CrossMediumIcon } from "@/components/icons/cross-medium"
import { OpenQuote2Icon } from "@/components/icons/open-quote-2"
import Button from "@/components/ui/button"
import { VoiceRecorder } from "@/components/voice-recorder"

export type ChatSelection = { id: string; text: string }

/** A slash extension the agent offers — one row in the composer's `/` menu. */
export type SlashCommandItem = { name: string; description?: string | null }

export type ChatInputProps = {
  panel: ChatPanelState
  /** A turn is in flight — the submit button becomes a stop control. */
  isGenerating: boolean
  /** Quoted passages the user picked out of the transcript. */
  selections: ChatSelection[]
  onClearSelections: () => void
  /** A send the server rejected — surfaced above the composer. */
  sendError: string | null
  onDismissSendError: () => void
  /** A failed vault write — keeps the credential form open with the reason. */
  secretError: string | null
  onSubmitMessage: (
    text: string,
    files: AttachmentItem[]
  ) => void | Promise<void>
  onAnswerQuestions: (answers: ComposerAnswerEntry[]) => void
  onSaveSecret: (values: Record<string, string>, declined: boolean) => void
  onVoiceTranscribed: (text: string, durationMs: number) => void
  onStop: () => void
  /** The agent's slash extensions; `/` at the start of the message opens them. */
  slashCommands?: SlashCommandItem[]
}

const ChatInputInner = memo(
  ({
    panel,
    isGenerating,
    selections,
    onClearSelections,
    sendError,
    onDismissSendError,
    secretError,
    onSubmitMessage,
    onAnswerQuestions,
    onSaveSecret,
    onVoiceTranscribed,
    onStop,
    slashCommands,
  }: ChatInputProps) => {
    const isAskUser = panel.type === "ask-user"

    // The `/` menu: picking an item replaces the trigger with `/name ` so the
    // user types the arguments; the runtime parses the text like any typed
    // command (unknown `/paths` stay ordinary messages).
    const commands = useMemo<ComposerCommandsMap | undefined>(() => {
      if (!slashCommands?.length) return undefined
      return {
        "/": {
          kind: "execute",
          trigger: "doc-start",
          suggestion: false,
          items: slashCommands.map((c) => ({
            value: c.name,
            label: `/${c.name}`,
            description: c.description ?? undefined,
            keywords: c.description ?? undefined,
            onSelect: ({ editor }) => {
              editor.clear()
              editor.insertText(`/${c.name} `)
              editor.focus()
            },
          })),
        },
      }
    }, [slashCommands])
    const isSecretRequest = panel.type === "secret-request"

    // The credential form's values. Held here, not in a store: they exist only
    // between keystroke and save, and reset the moment the request changes.
    const [secretValues, setSecretValues] = useState<Record<string, string>>({})
    const secretCallId = isSecretRequest ? panel.toolCallId : null
    useEffect(() => {
      setSecretValues({})
    }, [secretCallId])

    const handleSubmit = (data: ComposerSubmitData) => {
      if (data.kind === "answers") {
        if (isAskUser) onAnswerQuestions(data.answers)
        return
      }
      void onSubmitMessage(data.text, data.files)
    }

    return (
      <>
        {sendError && (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <span className="flex-1">{sendError}</span>
            <button
              type="button"
              className="opacity-70 hover:opacity-100"
              onClick={onDismissSendError}
            >
              Dismiss
            </button>
          </div>
        )}

        <Composer
          onSubmit={handleSubmit}
          isSubmitting={isGenerating}
          questions={isAskUser ? panel.questions : undefined}
          commands={commands}
        >
          <Composer.Panel>
            {(composer) => {
              // One at a time, by priority: the composer's own ask-user flow,
              // then the agent's `/` menu, then the credential form.
              if (composer.askUser.active) return <Composer.AskUser />
              if (commands && composer.commands.trigger === "/") {
                return <Composer.Commands prefix="/" />
              }
              if (isSecretRequest) {
                return (
                  <SecretRequestForm
                    request={panel.request}
                    values={secretValues}
                    onValueChange={(key, value) =>
                      setSecretValues((previous) => ({
                        ...previous,
                        [key]: value,
                      }))
                    }
                    error={secretError}
                  />
                )
              }
              return null
            }}
          </Composer.Panel>

          <Composer.ContextWindow>
            {selections.length > 0 && (
              <div className="flex items-center gap-1.5 text-ink-secondary">
                <OpenQuote2Icon className="size-3.5" />
                <span>
                  {selections.length} selection
                  {selections.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  aria-label="Clear selections"
                  className="cursor-pointer rounded-full p-0.5 hover:bg-primary-bg-hover hover:text-ink-primary"
                  onClick={onClearSelections}
                >
                  <CrossMediumIcon className="size-3" />
                </button>
              </div>
            )}
          </Composer.ContextWindow>

          <Composer.Container>
            <Composer.Attachments />
            <Composer.Textarea autoFocus>
              <Composer.Placeholder
                placeholder={
                  isAskUser
                    ? "Or type your own answer…"
                    : isSecretRequest
                      ? "Or reply instead of filling the form…"
                      : isGenerating
                        ? "Thinking…"
                        : "Message the agent…"
                }
              />
            </Composer.Textarea>

            {isAskUser ? (
              <Composer.Actions className="flex items-center justify-end gap-2">
                <Composer.AskUserHints />
                <Composer.AskUserDismiss />
                <Composer.AskUserContinue />
              </Composer.Actions>
            ) : isSecretRequest ? (
              <Composer.Actions className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSaveSecret({}, true)}
                >
                  Skip
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  size="sm"
                  onClick={() => onSaveSecret(secretValues, false)}
                >
                  Save
                </Button>
              </Composer.Actions>
            ) : (
              <Composer.Actions className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Composer.AttachmentTrigger />
                  <VoiceRecorder onTranscribed={onVoiceTranscribed} />
                </div>
                <Composer.Submit isGenerating={isGenerating} onStop={onStop} />
              </Composer.Actions>
            )}
          </Composer.Container>
        </Composer>
      </>
    )
  }
)

ChatInputInner.displayName = "ChatInputInner"

export const ChatInput = ChatInputInner
