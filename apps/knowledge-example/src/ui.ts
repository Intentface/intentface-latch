/*
 * Class strings from the @intentface/chat docs demos (ui.intentface.com), shared
 * so the sidebar, tabs, thread and composer read as one surface. The package
 * ships no styles: everything that looks like something lives here.
 */

export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0169cc]/60";

/** The window's ground, behind the sidebar and the tab strip. */
export const GROUND = "bg-[#f5f5f6] dark:bg-[#131315]";

/** A white card lifted off the ground: the open tab's content. */
export const CARD =
  "bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.06),0_4px_8px_-2px_rgb(0_0_0/0.05)] dark:bg-zinc-900 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.05),inset_0_0_0_1px_rgb(255_255_255/0.06),0_0_0_1px_rgb(0_0_0/0.16),0_1px_2px_rgb(0_0_0/0.1)]";

/** A control raised off the ground: the selected tab, the selected row, a pill button. */
export const RAISED =
  "bg-white bg-linear-to-b from-white to-[#fdfdfd] text-zinc-900 shadow-[inset_0_1px_0_#fff,0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.07),0_2px_6px_-2px_rgb(0_0_0/0.05)] dark:bg-[#2d2d30] dark:from-[#313134] dark:to-[#2a2a2d] dark:text-zinc-100 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),inset_0_0_0_1px_rgb(255_255_255/0.05),0_0_0_1px_rgb(0_0_0/0.16),0_1px_2px_rgb(0_0_0/0.1)]";

/**
 * A sidebar row, for leaves and group headings alike. The explicit height is
 * load-bearing (13px text has a fractional line-height), and there's no
 * overflow-hidden: the rail is drawn outside the row's box.
 */
export const NAV_ROW = [
  "group/row flex h-[30px] shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 font-medium text-[13px]",
  "text-zinc-700 no-underline transition-colors dark:text-zinc-300",
  "hover:bg-zinc-950/5 hover:text-zinc-900 dark:hover:bg-white/8 dark:hover:text-zinc-100",
  "focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#0169cc]/60",
  "data-[active]:bg-white data-[active]:bg-linear-to-b data-[active]:from-white data-[active]:to-[#fdfdfd] data-[active]:text-zinc-900 data-[active]:shadow-[inset_0_0_0_1px_rgb(0_0_0/0.075),0_1px_2px_rgb(0_0_0/0.07),0_2px_6px_-2px_rgb(0_0_0/0.05)]",
  "dark:data-[active]:bg-[#2d2d30] dark:data-[active]:from-[#29292c] dark:data-[active]:to-[#242427] dark:data-[active]:text-zinc-100 dark:data-[active]:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),inset_0_0_0_1px_rgb(255_255_255/0.05),0_0_0_1px_rgb(0_0_0/0.16),0_1px_2px_rgb(0_0_0/0.1)]",
  "[&_svg]:size-4 [&_svg]:shrink-0",
].join(" ");

export const NAV_LIST = "flex flex-col gap-0.5";

/** A section heading in the sidebar, above a nav. */
export const SECTION_LABEL = "px-2 pt-3 pb-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400";

/** The user's message: a pill; the assistant's text sits bare on the card. */
export const USER_BUBBLE =
  "max-w-[80%] rounded-[20px] bg-white px-3.5 py-1.5 text-sm text-zinc-900 leading-6 whitespace-pre-wrap shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.04)] dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.05),inset_0_0_0_1px_rgb(255_255_255/0.06),0_0_0_1px_rgb(0_0_0/0.16)]";

/** The accent: the send button and the logo tile. */
export const ACCENT =
  "bg-[#0169cc] bg-linear-to-b from-[oklch(57.2%_0.166_253.2)] to-[oklch(52.9%_0.173_255)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_0_0_1px_oklch(46.5%_0.146_254.8),0_1px_2px_rgb(1_105_204/0.35)]";

/** Round icon buttons on the ground: collapse the sidebar, new chat. */
export const ICON_BUTTON = `grid size-7 shrink-0 cursor-pointer select-none place-items-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-950/5 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-white/8 dark:hover:text-zinc-100 ${FOCUS_RING}`;
