import { AnimatePresence, motion } from "motion/react";
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils.js";
import { ProgressiveBlur } from "./progressive-blur.js";

/**
 * Thread — a generic scroll viewport with four auto-scroll modes (ported from
 * intentface-chat). Auto-scroll is driven by the `autoScroll` prop; nothing here
 * knows about chats/messages. Compose: Thread.Overlay / Viewport / Composer /
 * ScrollButton / Placeholder.
 */
type ThreadContextValue = {
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
};

const ThreadContext = createContext<ThreadContextValue | null>(null);

export const useThread = () => {
  const ctx = use(ThreadContext);
  if (!ctx) throw new Error("useThread must be used within <Thread>");
  return ctx;
};

const scrollContainerTo = (el: HTMLElement, top: number, behavior: ScrollBehavior) =>
  el.scrollTo({ top, behavior });

export type ThreadAutoScrollMode = "off" | "bottom" | "jump" | "follow";

/**
 * Owns the scroll subsystem. Modes: "off" plain scroll; "bottom" newest lands at
 * the bottom + follows; "jump" newest lands at the top (reserve), no follow;
 * "follow" newest lands at the top + follows (ChatGPT/Claude).
 */
const useThreadScroll = (mode: ThreadAutoScrollMode): ThreadContextValue => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(([entry]) => setIsAtBottom(entry.isIntersecting), { root });
    io.observe(sentinel);
    return () => io.disconnect();
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (el) scrollContainerTo(el, el.scrollHeight, behavior);
  }, []);

  const atBottomRef = useRef(isAtBottom);
  atBottomRef.current = isAtBottom;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || mode === "off") return;

    const landsAtTop = mode !== "bottom";
    const followsStream = mode !== "jump";

    if (landsAtTop) {
      content.style.setProperty("--thread-turn-min-height", "var(--thread-turn-area)");
    }

    let landed = false;
    let skipNextResize = true;
    const land = (mutations: MutationRecord[] = []) => {
      const replaced = mutations.some((m) => m.removedNodes.length > 0);
      skipNextResize = true;
      scrollToBottom(landed && !replaced ? "smooth" : "instant");
      landed = true;
    };
    const follow = () => {
      if (skipNextResize) {
        skipNextResize = false;
        return;
      }
      if (atBottomRef.current) scrollToBottom("smooth");
    };

    land();
    const turns = new MutationObserver(land);
    turns.observe(content, { childList: true });
    const growth = followsStream ? new ResizeObserver(follow) : null;
    growth?.observe(content);

    return () => {
      turns.disconnect();
      growth?.disconnect();
      if (landsAtTop) content.style.removeProperty("--thread-turn-min-height");
    };
  }, [mode, scrollToBottom]);

  return { isAtBottom, scrollToBottom, scrollRef, contentRef, sentinelRef };
};

export type ThreadRootProps = ComponentProps<"div"> & {
  children?: ReactNode;
  autoScroll?: ThreadAutoScrollMode;
};

const DEFAULT_BOTTOM_OFFSET = 128;
const COMPOSER_GAP = 32;
const DOCK_SELECTOR = '[data-slot="composer-container"]';

const measureComposerInset = (root: HTMLElement): number | null => {
  const dock = root.querySelector('[data-slot="composer-container"]');
  if (!dock) return null;
  return Math.round(
    root.getBoundingClientRect().bottom - dock.getBoundingClientRect().top + COMPOSER_GAP,
  );
};

const measureTopInset = (root: HTMLElement): number =>
  root.querySelector('[data-slot="thread-overlay-top"]')?.getBoundingClientRect().height ?? 0;

const useThreadInsets = () => {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apply = () => {
      const bottomInset = measureComposerInset(root);
      if (bottomInset !== null) {
        root.style.setProperty("--thread-overlay-bottom-height", `${bottomInset}px`);
      }
      const topInset = measureTopInset(root);
      const area = Math.max(
        0,
        Math.round(root.clientHeight - topInset - (bottomInset ?? DEFAULT_BOTTOM_OFFSET)),
      );
      root.style.setProperty("--thread-turn-area", `${area}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    for (const part of root.querySelectorAll(DOCK_SELECTOR)) observer.observe(part);
    return () => observer.disconnect();
  }, []);
  return rootRef;
};

const ThreadRoot = ({ children, className, autoScroll = "follow", ...props }: ThreadRootProps) => {
  const rootRef = useThreadInsets();
  const scroll = useThreadScroll(autoScroll);
  return (
    <ThreadContext value={scroll}>
      <div
        ref={rootRef}
        data-slot="thread-root"
        role="log"
        className={cn(
          "relative flex h-full w-full overflow-hidden [--thread-width:48rem] [--thread-overlay-top-height:3rem] [--thread-overlay-bottom-height:8rem]",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ThreadContext>
  );
};

export type ThreadOverlayProps = ComponentProps<typeof ProgressiveBlur> & {
  direction: "top" | "bottom";
};

const ThreadOverlay = memo(({ className, direction, ...props }: ThreadOverlayProps) => (
  <div
    data-slot={`thread-overlay-${direction}`}
    data-thread-overlay={direction}
    className={cn(
      "group/thread-overlay pointer-events-none absolute right-0 left-0 z-1 mx-auto w-full max-w-(--thread-width)",
      'data-[thread-overlay="top"]:top-0 data-[thread-overlay="top"]:h-(--thread-overlay-top-height)',
      'data-[thread-overlay="bottom"]:bottom-0 data-[thread-overlay="bottom"]:h-(--thread-overlay-bottom-height)',
      className,
    )}
  >
    <ProgressiveBlur
      direction={direction}
      className={cn(
        "pointer-events-none h-full w-full",
        "group-data-[thread-overlay='top']/thread-overlay:bg-linear-to-b from-secondary to-transparent",
        "group-data-[thread-overlay='bottom']/thread-overlay:bg-linear-to-t",
      )}
      {...props}
    />
  </div>
));
ThreadOverlay.displayName = "ThreadOverlay";

export type ThreadViewportProps = ComponentProps<"div"> & { children?: ReactNode };

const ThreadViewport = ({ children, className, ...props }: ThreadViewportProps) => {
  const { scrollRef, contentRef, sentinelRef } = useThread();
  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-x-hidden overflow-y-auto [overflow-anchor:auto] [scrollbar-color:var(--color-ink-tertiary)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin]"
    >
      <div
        data-slot="thread-viewport"
        className={cn(
          "@container/thread-viewport relative flex min-h-full w-full min-w-[340px] flex-col items-center",
          "has-data-[slot=thread-placeholder]:h-full",
          className,
        )}
        {...props}
      >
        <div className="relative flex min-h-full w-full flex-col items-center pt-(--thread-overlay-top-height) pb-(--thread-overlay-bottom-height)">
          <div
            ref={contentRef}
            data-slot="thread-content"
            className="mx-auto flex min-h-full w-full max-w-(--thread-width) flex-col gap-4 px-4 [&>*:last-child]:min-h-(--thread-turn-min-height,0px)"
          >
            {children}
          </div>
          <div ref={sentinelRef} data-slot="thread-bottom" aria-hidden className="h-px w-full shrink-0" />
        </div>
      </div>
    </div>
  );
};

const ThreadComposer = ({ className, children, ...props }: ComponentProps<"div">) => (
  <div
    data-slot="thread-composer"
    className={cn("absolute inset-x-0 bottom-0 z-2 mx-auto w-full max-w-(--thread-width)", className)}
    {...props}
  >
    <div className="relative flex w-full flex-col items-center px-4 pb-4">{children}</div>
  </div>
);

const ThreadScrollButton = ({ className, ...props }: ComponentProps<typeof motion.div>) => {
  const { isAtBottom, scrollToBottom } = useThread();
  return (
    <div className="absolute inset-x-0 -top-3 mx-auto flex h-0 w-full justify-center px-4">
      <div className="z-2 flex h-0 w-full max-w-(--thread-width) items-end justify-center">
        <AnimatePresence>
          {!isAtBottom && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.9 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className={className}
              {...props}
            >
              <button
                type="button"
                onClick={() => scrollToBottom()}
                className="bg-secondary border-primary-border text-ink-primary hover:bg-secondary-hover inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs shadow-md"
              >
                <ArrowDown className="size-3.5" />
                Latest
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

const ThreadPlaceholder = ({ children, className, ...props }: ComponentProps<"div">) => (
  <div
    data-slot="thread-placeholder"
    className={cn("flex flex-1 flex-col items-center justify-center gap-2 text-center", className)}
    {...props}
  >
    {children}
  </div>
);

export const Thread = Object.assign(ThreadRoot, {
  Overlay: ThreadOverlay,
  Viewport: ThreadViewport,
  Composer: ThreadComposer,
  Placeholder: ThreadPlaceholder,
  ScrollButton: ThreadScrollButton,
});
