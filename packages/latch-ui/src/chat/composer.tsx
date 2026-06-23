import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Paperclip, X } from "lucide-react";
import type { FileUIPart } from "ai";
import { cn } from "../lib/utils.js";

/** A picked-but-not-yet-sent file: the raw File plus a preview object URL. */
type Draft = { id: string; file: File; url: string };

const DEFAULT_ACCEPT = "image/*,application/pdf,text/*";

let draftSeq = 0;
const nextId = () => `f${++draftSeq}`;

/** Read a File into a `data:` URL so it can ride along as a FileUIPart. */
function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Chat composer: a squircle, rounded panel with an auto-growing textarea (Enter
 * sends, Shift+Enter newlines) and an accent send button — styled after
 * intentface-chat. Supports attachments via the paperclip button, paste, and
 * drag-and-drop; files are inlined as data-URL `file` parts and passed to
 * `onSubmit` alongside the text. `leading` is a slot for extra controls.
 */
export function Composer({
  onSubmit,
  disabled,
  placeholder = "Message the agent…",
  leading,
  className,
  allowAttachments = true,
  accept = DEFAULT_ACCEPT,
  maxFiles = 5,
  maxSizeMB = 10,
  capture = false,
  onCaptureKey,
}: {
  onSubmit: (text: string, files?: FileUIPart[]) => void;
  disabled?: boolean;
  placeholder?: string;
  leading?: ReactNode;
  className?: string;
  allowAttachments?: boolean;
  accept?: string;
  maxFiles?: number;
  maxSizeMB?: number;
  /**
   * Capture mode: focus stays here but the input is inert for text — keystrokes
   * are routed to `onCaptureKey` instead (used to drive the ask-user
   * questionnaire). The attach/send controls are hidden while active.
   */
  capture?: boolean;
  onCaptureKey?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<Draft[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const addFiles = (incoming: File[]) => {
    if (!allowAttachments || incoming.length === 0) return;
    const limit = maxSizeMB * 1024 * 1024;
    setFiles((prev) => {
      const room = Math.max(0, maxFiles - prev.length);
      const accepted = incoming.filter((f) => f.size <= limit).slice(0, room);
      return [...prev, ...accepted.map((file) => ({ id: nextId(), file, url: URL.createObjectURL(file) }))];
    });
  };

  const removeFile = (id: string) =>
    setFiles((prev) => {
      const gone = prev.find((f) => f.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((f) => f.id !== id);
    });

  const send = async () => {
    const text = value.trim();
    if ((!text && files.length === 0) || disabled) return;
    const parts: FileUIPart[] | undefined =
      files.length > 0
        ? await Promise.all(
            files.map(async (f) => ({
              type: "file" as const,
              filename: f.file.name,
              mediaType: f.file.type || "application/octet-stream",
              url: await toDataUrl(f.file),
            })),
          )
        : undefined;
    onSubmit(text, parts);
    setValue("");
    files.forEach((f) => URL.revokeObjectURL(f.url));
    setFiles([]);
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div
      data-slot="composer-container"
      onClick={() => ref.current?.focus()}
      onDragEnter={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => allowAttachments && e.preventDefault()}
      onDragLeave={() => {
        if (!allowAttachments) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
      className={cn(
        "border-primary-border bg-primary relative w-full cursor-text rounded-4xl border shadow-xs transition-colors [corner-shape:squircle]",
        dragging && "border-accent-border",
        className,
      )}
    >
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-2 pt-2">
          {files.map((f) => (
            <Thumb key={f.id} draft={f} onRemove={() => removeFile(f.id)} />
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        rows={1}
        value={capture ? "" : value}
        disabled={disabled}
        readOnly={capture}
        placeholder={placeholder}
        onChange={(e) => {
          if (capture) return;
          setValue(e.target.value);
          resize(e.target);
        }}
        onPaste={(e) => {
          if (capture || !allowAttachments) return;
          const pasted = [...e.clipboardData.items]
            .filter((i) => i.kind === "file")
            .map((i) => i.getAsFile())
            .filter((f): f is File => Boolean(f));
          if (pasted.length) {
            e.preventDefault();
            addFiles(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (capture) {
            if (onCaptureKey?.(e)) e.preventDefault();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        className="text-ink-primary placeholder:text-ink-tertiary max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 text-sm outline-none"
      />

      {!capture && (
      <div className="flex items-center gap-2 p-2">
        {allowAttachments && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={accept}
              className="hidden"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInput.current?.click();
              }}
              disabled={disabled || files.length >= maxFiles}
              aria-label="Attach files"
              className="text-ink-secondary hover:text-ink-primary hover:bg-primary-hover grid size-8 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40"
            >
              <Paperclip className="size-4" />
            </button>
          </>
        )}
        {leading}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void send();
          }}
          disabled={disabled || (!value.trim() && files.length === 0)}
          aria-label="Send"
          className="bg-accent ml-auto grid size-8 shrink-0 place-items-center rounded-full text-white transition-opacity disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      )}
    </div>
  );
}

/** Attachment pill: thumbnail/icon + filename + size, with a hover remove (×). */
function Thumb({ draft, onRemove }: { draft: Draft; onRemove: () => void }) {
  const isImage = draft.file.type.startsWith("image/");
  return (
    <div className="group border-secondary-border bg-secondary relative flex h-12 max-w-48 items-center gap-2 rounded-lg border px-2">
      {isImage ? (
        <img
          src={draft.url}
          alt={draft.file.name}
          className="ring-ink-primary/10 size-8 shrink-0 rounded-xs object-cover ring-1 ring-inset"
        />
      ) : (
        <div className="bg-primary-hover grid size-8 shrink-0 place-items-center rounded-md">
          <FileIcon className="text-ink-secondary size-4" />
        </div>
      )}
      <div className="flex min-w-0 flex-col">
        <span className="text-ink-primary truncate text-xs font-medium">{draft.file.name}</span>
        <span className="text-ink-tertiary text-[10px]">{formatSize(draft.file.size)}</span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label="Remove attachment"
        className="bg-ink-primary/70 text-base absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
