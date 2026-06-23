import { type HTMLMotionProps, motion } from "motion/react";
import { cn } from "../lib/utils.js";

export const GRADIENT_ANGLES = { top: 0, right: 90, bottom: 180, left: 270 };

export type ProgressiveBlurProps = {
  direction?: keyof typeof GRADIENT_ANGLES;
  blurLayers?: number;
  className?: string;
  blurIntensity?: number;
} & HTMLMotionProps<"div">;

/** A layered progressive blur (mask-stacked backdrop-filter), used for the
 *  fade overlays at the top/bottom of the thread. */
export const ProgressiveBlur = ({
  direction = "bottom",
  blurLayers = 8,
  className,
  blurIntensity = 0.25,
  ...props
}: ProgressiveBlurProps) => {
  const layers = Math.max(blurLayers, 2);
  const segmentSize = 1 / (blurLayers + 1);
  return (
    <div className={cn("relative", className)}>
      {Array.from({ length: layers }).map((_, index) => {
        const angle = GRADIENT_ANGLES[direction];
        const stops = [index, index + 1, index + 2, index + 3].map(
          (m, i) => `rgba(255,255,255,${i === 1 || i === 2 ? 1 : 0}) ${m * segmentSize * 100}%`,
        );
        const gradient = `linear-gradient(${angle}deg, ${stops.join(", ")})`;
        return (
          <motion.div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length layer stack
            key={index}
            className="pointer-events-none absolute inset-0 rounded-[inherit]"
            style={{
              maskImage: gradient,
              WebkitMaskImage: gradient,
              backdropFilter: `blur(${index * blurIntensity}px)`,
              WebkitBackdropFilter: `blur(${index * blurIntensity}px)`,
            }}
            {...props}
          />
        );
      })}
    </div>
  );
};
