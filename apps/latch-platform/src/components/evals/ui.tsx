import { useEffect, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Evals pages' visual language: flat bordered cards, colour only inside
 * charts, plain section headings over a hairline. Defined once so every page
 * reads the same.
 */

/** A card: flat, bordered, no shadow — the surface lifts off the ground by tone and a hairline. */
export const CARD = "rounded-lg border border-primary-border bg-primary-bg";

/** The page wrapper. The app's own background, like every other page. */
export const GROUND = "min-h-full";

export function SectionTitle({ id, children, aside }: { id: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="border-primary-border flex items-end gap-3 border-t pt-5">
      <h2 id={`${id}-title`} className="text-ink-primary text-lg font-semibold tracking-tight">
        {children}
      </h2>
      {aside && <div className="text-ink-tertiary ml-auto text-sm">{aside}</div>}
    </div>
  );
}

/** A chart's frame: what it shows, how to read it, and a link to it. */
export function ChartCard({
  id,
  title,
  subtitle,
  actions,
  children,
  flush,
}: {
  id: string;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Content runs to the card's edges (tables). */
  flush?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const url = new URL(window.location.href);
    url.hash = id;
    void navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-start gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-ink-primary text-[15px] font-semibold">{title}</h3>
          <p className="text-ink-tertiary mt-0.5 max-w-[80ch] text-xs">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <button
            type="button"
            onClick={copy}
            aria-label="Copy a link to this chart"
            title="Copy a link to this chart"
            className="border-primary-border text-ink-secondary hover:text-ink-primary hover:bg-primary-bg-hover flex size-8 items-center justify-center rounded-md border"
          >
            {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
          </button>
        </div>
      </div>
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </div>
  );
}

/**
 * The sections of a long page, pinned beside it; the one in view is marked.
 * Hidden on narrow screens, where the page is short enough to scroll.
 */
export function SectionNav({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id);
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top).at(0);
        if (top) setActive(top.target.id);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections]);
  return (
    <nav aria-label="Sections" className="evals-nav sticky top-6 hidden self-start xl:block">
      <ul className="border-primary-border space-y-1 border-t pt-4 text-sm">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "location" : undefined}
              className={cn("block py-0.5", active === s.id ? "text-ink-primary font-medium" : "text-ink-tertiary hover:text-ink-secondary")}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A pill label, the way the reference names what a card is about. */
export function Pill({ children }: { children: React.ReactNode }) {
  return <span className="bg-primary-bg-hover text-ink-secondary inline-block rounded-full px-2.5 py-0.5 text-xs font-medium">{children}</span>;
}

/**
 * A pass rate as a colour on the evals scale: fail → neutral → pass, mixed
 * in OKLCH so the middle stays grey instead of muddy. The rate is always
 * printed as well; colour is never the only encoding.
 */
export function passColor(rate: number): string {
  const r = Math.max(0, Math.min(1, rate));
  return r < 0.5
    ? `color-mix(in oklch, var(--eval-bad) ${Math.round((1 - r * 2) * 100)}%, var(--eval-mid))`
    : `color-mix(in oklch, var(--eval-good) ${Math.round((r - 0.5) * 200)}%, var(--eval-mid))`;
}
