import type { UIMessage } from "ai";

/** An inline mention/reference chip (e.g. `@agent`, `/command`). */
export type ChipData = {
  prefix: string;
  value: string;
  label: string;
  icon?: string;
  variant?: "primary" | "accent" | "warning";
};

/** The app's UIMessage: `stopped` metadata + a `chip` data part. */
export type AppUIMessage = UIMessage<{ stopped?: boolean }, { chip: ChipData[] }>;
