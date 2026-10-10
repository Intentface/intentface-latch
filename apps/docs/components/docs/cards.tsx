import { ArrowRight } from "@keyline-icons/react";
import Link from "next/link";
import type { ReactNode } from "react";

/** A grid of link cards. */
export const Cards = ({ children }: { children: ReactNode }) => (
  <div className="not-prose my-6 grid gap-2.5 sm:grid-cols-2">{children}</div>
);

/** A link to another page: a title and one line on what's there. */
export const Card = ({ href, title, description }: { href: string; title: ReactNode; description?: ReactNode }) => (
  <Link
    href={href}
    className="group flex flex-col gap-1 rounded-xl bg-primary-bg px-4 py-3.5 shadow-card transition-colors hover:bg-primary-bg-hover focus-visible:outline-2 focus-visible:outline-accent-bg/60"
  >
    <span className="flex items-center justify-between gap-2 font-medium text-ink-primary text-lg">
      {title}
      <ArrowRight className="size-3.5 shrink-0 text-ink-tertiary transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-ink-primary" />
    </span>
    {description && <span className="text-ink-secondary text-md leading-5">{description}</span>}
  </Link>
);
