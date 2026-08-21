/**
 * The empty-thread placeholder — the mark, the agent's name, and one line of
 * invitation, staggered in. Same composition as intentface-chat's, with Latch's
 * mark and the agent whose thread this is.
 */

import { AnimatePresence, motion, stagger } from "motion/react"
import { LatchFace } from "@/components/latch-logo"

const variants = {
  hidden: { opacity: 0, y: 8, filter: "blur(4px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)" },
}

export const ChatPlaceholder = ({ agent }: { agent: string }) => (
  <AnimatePresence>
    <motion.div
      variants={variants}
      initial="hidden"
      animate="visible"
      exit="hidden"
      transition={{
        duration: 0.5,
        ease: "easeOut",
        delayChildren: stagger(0.1, { from: "first", startDelay: 0.15 }),
      }}
      className="flex flex-col items-center justify-center gap-4"
    >
      <motion.div variants={variants}>
        <LatchFace className="size-12" />
      </motion.div>
      <div className="flex flex-col items-center justify-center">
        <motion.span variants={variants} className="text-lg font-semibold">
          {agent}
        </motion.span>
        <motion.span variants={variants} className="text-sm text-ink-secondary">
          Start a conversation
        </motion.span>
      </div>
    </motion.div>
  </AnimatePresence>
)
