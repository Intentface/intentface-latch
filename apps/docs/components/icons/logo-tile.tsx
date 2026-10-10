import { cn } from "@/lib/utils";
import { LatchLogo } from "./latch-logo";

type LogoTileProps = {
  size?: "sm" | "lg";
  className?: string;
};

// The Latch mark (the bracket and its eyes) in its brand gradient: on a white
// tile in light mode, and on the dark tile the brand kit shows it on in dark.
export const LogoTile = ({ size = "sm", className }: LogoTileProps) => (
  <span
    aria-hidden="true"
    className={cn(
      "flex shrink-0 items-center justify-center",
      // Bevelled like the send button: a face lit from above, a highlight on
      // its top edge and a soft shade along the bottom, inside a crisp ring.
      "bg-linear-to-b from-white to-[#ececef] dark:from-[#2a2a30] dark:to-[#16161a]",
      "shadow-[inset_0_1px_0_rgb(255_255_255),inset_0_-2px_3px_rgb(0_0_0/0.06),0_0_0_1px_rgb(0_0_0/0.09),0_1px_2px_rgb(0_0_0/0.1)]",
      "dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.12),inset_0_-2px_3px_rgb(0_0_0/0.4),0_0_0_1px_rgb(0_0_0/0.6),0_1px_2px_rgb(0_0_0/0.4)]",
      size === "sm" ? "size-6 rounded-md" : "size-12 rounded-xl",
      className,
    )}
  >
    <LatchLogo label="" size={size === "sm" ? 12 : 24} />
  </span>
);
