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
      "flex shrink-0 items-center justify-center bg-white dark:bg-[#18181c]",
      "shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_1px_2px_rgb(0_0_0/0.08)]",
      "dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_0_0_1px_rgb(255_255_255/0.08)]",
      size === "sm" ? "size-6 rounded-md" : "size-12 rounded-xl",
      className,
    )}
  >
    <LatchLogo label="" size={size === "sm" ? 12 : 24} />
  </span>
);
