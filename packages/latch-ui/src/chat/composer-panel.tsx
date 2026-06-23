import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";

/**
 * Presence wrapper for composer panels — keeps latch-ui's motion dependency
 * out of the host. Put keyed `<ComposerPanel>`s inside; swapping which one is
 * rendered animates the old one out and the new one in.
 */
export function ComposerPanelGroup({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

/**
 * Animated panel that rises from behind the composer (slide up + fade, growing
 * to its content height) in a squircle card — used for the loading step queue
 * and the ask-user questionnaire. Render inside an `<AnimatePresence>` and give
 * each panel a stable `key` so swapping states animates out/in. Mirrors
 * intentface-chat's `Composer.Panel`.
 */
export function ComposerPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ y: "100%", opacity: 0, height: 0 }}
      animate={{ y: 0, opacity: 1, height: "auto" }}
      exit={{ y: "100%", opacity: 0, height: 0 }}
      transition={{ duration: 0.3, type: "spring", bounce: 0 }}
      className={cn(
        "border-primary-border bg-primary mb-2 w-full overflow-hidden rounded-4xl border shadow-xs [corner-shape:squircle]",
        className,
      )}
    >
      {children}
    </motion.div>
  );
}
