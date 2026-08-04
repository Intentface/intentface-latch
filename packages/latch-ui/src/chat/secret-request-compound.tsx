import { LockIcon, ShieldCheckIcon } from "lucide-react";
import { type ComponentProps, useId } from "react";
import { cn } from "../lib/utils.js";
import type { SecretRequestField } from "./secret-request.js";

/**
 * The secret-entry form's presentational shell. Stateless, like
 * {@link AskUser} — the composer store owns the values so the host can submit
 * them without this component ever holding a credential longer than a keystroke.
 */
type SecretRequestRootProps = ComponentProps<"div">;

const SecretRequestRoot = ({ className, ...props }: SecretRequestRootProps) => (
  <div className={cn("flex flex-col gap-2 p-2", className)} {...props} />
);

type SecretRequestHeaderProps = ComponentProps<"div">;

const SecretRequestHeader = ({ className, ...props }: SecretRequestHeaderProps) => (
  <div className={cn("flex items-center gap-2 px-2", className)} {...props} />
);

type SecretRequestTitleProps = ComponentProps<"p">;

const SecretRequestTitle = ({ className, children, ...props }: SecretRequestTitleProps) => (
  <p
    className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sm leading-tight font-medium", className)}
    {...props}
  >
    <LockIcon className="text-ink-secondary size-3.5 shrink-0" />
    {children}
  </p>
);

/** Where the values will live — always visible, never guessable. */
type SecretRequestScopeProps = ComponentProps<"span"> & { scope: "user" | "org" };

const SecretRequestScope = ({ className, scope, ...props }: SecretRequestScopeProps) => (
  <span
    className={cn(
      "border-primary-border text-ink-tertiary shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]",
      className,
    )}
    {...props}
  >
    {scope === "org" ? "shared with your org" : "only you"}
  </span>
);

type SecretRequestFieldsProps = ComponentProps<"div">;

const SecretRequestFields = ({ className, ...props }: SecretRequestFieldsProps) => (
  <div className={cn("flex flex-col gap-2 px-2", className)} {...props} />
);

/**
 * One labelled input. Secret fields are password inputs with autofill and
 * spellcheck off — a spellchecker would ship the value to a remote service, and
 * autofill would offer to persist it in the browser.
 */
type SecretRequestFieldProps = Omit<ComponentProps<"input">, "value" | "onChange"> & {
  field: SecretRequestField;
  value: string;
  onValueChange: (value: string) => void;
};

const SecretRequestFieldRow = ({
  className,
  field,
  value,
  onValueChange,
  ...props
}: SecretRequestFieldProps) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-ink-secondary flex items-baseline gap-2 text-xs">
        <span className="font-medium">{field.label}</span>
        {field.secret && field.name && (
          <span className="text-ink-tertiary truncate font-mono text-[11px]">
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
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          "border-primary-border bg-primary text-ink-primary placeholder:text-ink-tertiary focus-visible:border-ink-tertiary w-full rounded-md border px-2 py-1.5 text-sm outline-none",
          className,
        )}
        {...props}
      />
      {field.hint && <p className="text-ink-tertiary text-[11px]">{field.hint}</p>}
    </div>
  );
};

/** The standing reassurance about where the value goes. */
type SecretRequestNoteProps = ComponentProps<"p">;

const SecretRequestNote = ({ className, children, ...props }: SecretRequestNoteProps) => (
  <p
    className={cn("text-ink-tertiary flex items-center gap-1.5 px-2 text-[11px]", className)}
    {...props}
  >
    <ShieldCheckIcon className="size-3 shrink-0" />
    {children ??
      "Stored encrypted in your vault and sent only to the service it belongs to. The agent sees the name, never the value."}
  </p>
);

type SecretRequestErrorProps = ComponentProps<"p">;

const SecretRequestError = ({ className, ...props }: SecretRequestErrorProps) => (
  <p className={cn("px-2 text-xs text-red-500", className)} {...props} />
);

export const SecretRequest = Object.assign(SecretRequestRoot, {
  Header: SecretRequestHeader,
  Title: SecretRequestTitle,
  Scope: SecretRequestScope,
  Fields: SecretRequestFields,
  Field: SecretRequestFieldRow,
  Note: SecretRequestNote,
  Error: SecretRequestError,
});
