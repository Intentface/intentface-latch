/**
 * The credential form an agent can open in the composer.
 *
 * Presentational only — the values live in the caller's state so nothing here
 * holds a credential longer than a keystroke, and the caller is the one that
 * posts them to the vault endpoint (never through the chat stream).
 */

import { LockIcon, ShieldCheckIcon } from "lucide-react"
import { useId } from "react"
import type {
  SecretRequestField,
  SecretRequestInput,
} from "@/lib/ai/secret-request"
import { cn } from "@/lib/utils"

/**
 * One labelled input. Secret fields are password inputs with autofill and
 * spellcheck off — a spellchecker would ship the value to a remote service, and
 * autofill would offer to persist it in the browser.
 */
const SecretField = ({
  field,
  value,
  onValueChange,
}: {
  field: SecretRequestField
  value: string
  onValueChange: (value: string) => void
}) => {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="flex items-baseline gap-2 text-xs text-ink-secondary"
      >
        <span className="font-medium">{field.label}</span>
        {field.secret && field.name && (
          <span className="truncate font-mono text-2xs text-ink-tertiary">
            saved as {field.name}
          </span>
        )}
      </label>
      <input
        id={id}
        type={field.secret ? "password" : "text"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(
          "w-full rounded-md border border-primary-border bg-primary-bg px-2 py-1.5 text-sm text-ink-primary outline-none",
          "placeholder:text-ink-tertiary focus-visible:border-primary-border-hover"
        )}
      />
      {field.hint && <p className="text-2xs text-ink-tertiary">{field.hint}</p>}
    </div>
  )
}

export const SecretRequestForm = ({
  request,
  values,
  onValueChange,
  error,
}: {
  request: SecretRequestInput
  values: Record<string, string>
  onValueChange: (key: string, value: string) => void
  error?: string | null
}) => (
  <div className="flex flex-col gap-2 p-2">
    <div className="flex items-center gap-2 px-2">
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-sm leading-tight font-medium text-ink-primary">
        <LockIcon className="size-3.5 shrink-0 text-ink-secondary" />
        {request.title}
      </p>
      {/* Where the values will live — always visible, never guessable. */}
      <span className="shrink-0 rounded-md border border-primary-border px-1.5 py-0.5 text-2xs text-ink-tertiary">
        {request.scope === "org" ? "shared with your org" : "only you"}
      </span>
    </div>

    <div className="flex flex-col gap-2 px-2">
      {request.fields.map((field) => (
        <SecretField
          key={field.key}
          field={field}
          value={values[field.key] ?? ""}
          onValueChange={(value) => onValueChange(field.key, value)}
        />
      ))}
    </div>

    <p className="flex items-center gap-1.5 px-2 text-2xs text-ink-tertiary">
      <ShieldCheckIcon className="size-3 shrink-0" />
      Stored encrypted in your vault and sent only to the service it belongs to.
      The agent sees the name, never the value.
    </p>

    {error && <p className="px-2 text-xs text-destructive">{error}</p>}
  </div>
)
