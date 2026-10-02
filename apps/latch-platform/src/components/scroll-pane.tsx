import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { useSettingsStore } from "@/lib/store/settings";
import { cn } from "@/lib/utils";

/**
 * The page's scroll area, with the chat's soft edges: content passing under
 * the top or bottom edge blurs out instead of being cut off. Same blur as the
 * thread (ProgressiveBlur), same display setting ("overlays").
 *
 * Each edge shows only while there is content beyond it — the top once you
 * have scrolled, the bottom while there is more below — so a page at rest
 * never sits under a haze. Chat pages have their own (the thread's overlays
 * are sized to its header and composer), so this stays out of their way.
 */
export function ScrollPane({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const showOverlays = useSettingsStore((s) => s.showOverlays);
  const onChat = useRouterState({ select: (s) => s.location.pathname.startsWith("/chat") });
  const enabled = showOverlays && !onChat;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // Content that grows or shrinks (a run finishing, a drawer closing) changes the answer too.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [enabled]);

  return (
    <div className="relative h-full min-w-0 flex-1">
      <div ref={ref} className="h-full overflow-auto">
        {children}
      </div>
      {enabled && (
        <>
          <Edge side="top" visible={edges.top} />
          <Edge side="bottom" visible={edges.bottom} />
        </>
      )}
    </div>
  );
}

function Edge({ side, visible }: { side: "top" | "bottom"; visible: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 transition-opacity duration-200",
        side === "top" ? "top-0 h-10" : "bottom-0 h-14",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <ProgressiveBlur
        direction={side}
        className={cn("h-full w-full from-secondary-bg to-transparent", side === "top" ? "bg-linear-to-b" : "bg-linear-to-t")}
      />
    </div>
  );
}
