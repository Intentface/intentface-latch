import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../lib/utils.js";

type ScalerProps = {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  tickStep?: number;
  disabled?: boolean;
  className?: string;
};

/**
 * Compact "scaler" slider: a filled rounded track with evenly spaced tick marks,
 * a thin vertical thumb that fades in on hover/focus, and a right-aligned value
 * readout. Ported from intentface-chat's settings layout.
 */
export const Scaler = ({
  value,
  onValueChange,
  min,
  max,
  step,
  tickStep,
  disabled,
  className,
}: ScalerProps) => {
  const tickCount = tickStep ? Math.max(0, Math.floor((max - min) / tickStep) - 1) : 0;

  const handleValueChange = (next: number | readonly number[]) => {
    onValueChange(typeof next === "number" ? next : next[0]);
  };

  return (
    <SliderPrimitive.Root
      value={value}
      onValueChange={handleValueChange}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("group relative h-9 w-full touch-none", className)}
    >
      <SliderPrimitive.Control className="relative flex h-full w-full items-stretch">
        <SliderPrimitive.Track className="bg-base relative h-full w-full overflow-hidden rounded-md">
          {tickCount > 0 && (
            <div className="pointer-events-none absolute inset-x-3 inset-y-2.5 z-0 flex items-stretch justify-between">
              {Array.from({ length: tickCount }, (_, i) => (
                <span key={i} className="bg-ink-primary/15 w-px" />
              ))}
            </div>
          )}
          <SliderPrimitive.Indicator className="bg-ink-primary/10 rounded-none" />
          <SliderPrimitive.Thumb className="bg-ink-primary h-full w-1 rounded-full border-0 opacity-0 shadow-none transition-opacity group-hover:opacity-80 focus-visible:opacity-100 data-[active]:opacity-100" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-end px-3">
        <span className="text-ink-secondary text-sm tabular-nums">{value.toFixed(2)}</span>
      </div>
    </SliderPrimitive.Root>
  );
};
