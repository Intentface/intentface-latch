import { cn } from "@/lib/utils";
import { LatchLogo } from "./latch-logo";

type LogoTileProps = {
  size?: "sm" | "lg";
  className?: string;
};

// The Latch mark (the bracket and its eyes) in its brand gradient, on a tile.
export const LogoTile = ({ size = "sm", className }: LogoTileProps) => (
  <span
    aria-hidden="true"
    className={cn(
      // The same raised face as the buttons ("Copy page"): lit from above,
      // with their ring and shadow, in both themes.
      "flex shrink-0 items-center justify-center bg-raised shadow-raised",
      size === "sm" ? "size-6 rounded-md" : "size-12 rounded-xl",
      className,
    )}
  >
    <LatchLogo label="" size={size === "sm" ? 12 : 24} />
  </span>
);
