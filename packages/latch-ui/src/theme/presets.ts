import { z } from "zod";

/**
 * Theme seeds + presets (ported from intentface-chat). The whole palette
 * derives from four seeds (`bg`/`fg`/`acc`/`con`) via OKLCH in theme.css, so a
 * preset is just those four values per mode.
 */

export const CONTRAST_MIN = 0.1;
export const CONTRAST_MAX = 0.6;
export const CONTRAST_DEFAULT = 0.3;
export const CONTRAST_STEP = 0.01;

export const HexSchema = z
  .string()
  .trim()
  .transform((value) => (value.startsWith("#") ? value : `#${value}`).toLowerCase())
  .pipe(z.string().regex(/^#[0-9a-f]{6}$/));

export const ContrastSchema = z
  .number()
  .transform((value) =>
    Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, Number.isNaN(value) ? CONTRAST_DEFAULT : value)),
  );

const SeedsSchema = z.object({
  bg: HexSchema,
  fg: HexSchema,
  acc: HexSchema,
  con: ContrastSchema,
});

export const ThemeStateSchema = z.object({ light: SeedsSchema, dark: SeedsSchema });

export type CustomSeeds = z.infer<typeof SeedsSchema>;
export type ThemeState = z.infer<typeof ThemeStateSchema>;
export type ThemeMode = "light" | "dark";

export type PresetDefinition = { label: string; seeds: CustomSeeds };

export const DEFAULT_LIGHT_SEEDS: CustomSeeds = { bg: "#ffffff", fg: "#1a1a1a", acc: "#0169cc", con: CONTRAST_DEFAULT };
export const DEFAULT_DARK_SEEDS: CustomSeeds = { bg: "#111111", fg: "#fcfcfc", acc: "#4a9eed", con: CONTRAST_DEFAULT };

const c = CONTRAST_DEFAULT;
export const LIGHT_PRESETS: readonly PresetDefinition[] = [
  { label: "Default", seeds: DEFAULT_LIGHT_SEEDS },
  { label: "Absolutely", seeds: { bg: "#f9f9f7", fg: "#2d2d2b", acc: "#cc7d5e", con: c } },
  { label: "Codex", seeds: { bg: "#ffffff", fg: "#0d0d0d", acc: "#0169cc", con: c } },
  { label: "Linear", seeds: { bg: "#fcfcfd", fg: "#1b1b1b", acc: "#5e6ad2", con: c } },
  { label: "Notion", seeds: { bg: "#ffffff", fg: "#37352f", acc: "#3183d8", con: c } },
  { label: "Proof", seeds: { bg: "#f5f3ed", fg: "#2f312d", acc: "#3d755d", con: c } },
  { label: "Raycast", seeds: { bg: "#ffffff", fg: "#030303", acc: "#ff6363", con: c } },
  { label: "Vercel", seeds: { bg: "#ffffff", fg: "#171717", acc: "#006aff", con: c } },
];

export const DARK_PRESETS: readonly PresetDefinition[] = [
  { label: "Default", seeds: DEFAULT_DARK_SEEDS },
  { label: "Absolutely", seeds: { bg: "#2d2d2b", fg: "#f9f9f7", acc: "#cc7d5e", con: c } },
  { label: "Ayu", seeds: { bg: "#0b0e14", fg: "#bfbdb6", acc: "#e6b450", con: c } },
  { label: "Codex", seeds: { bg: "#111111", fg: "#fcfcfc", acc: "#0169cc", con: c } },
  { label: "GitHub", seeds: { bg: "#0d1117", fg: "#e6edf3", acc: "#1f6feb", con: c } },
  { label: "Linear", seeds: { bg: "#0f0f11", fg: "#e3e4e6", acc: "#606acc", con: c } },
  { label: "Lobster", seeds: { bg: "#111827", fg: "#e4e4e7", acc: "#ff5c5c", con: c } },
  { label: "Notion", seeds: { bg: "#191919", fg: "#d9d9d8", acc: "#3183d8", con: c } },
  { label: "Oscurange", seeds: { bg: "#0b0b0f", fg: "#e6e6e6", acc: "#f9b98c", con: c } },
  { label: "Raycast", seeds: { bg: "#101010", fg: "#fefefe", acc: "#ff6363", con: c } },
  { label: "Sentry", seeds: { bg: "#2d2935", fg: "#e6dff9", acc: "#7055f6", con: c } },
  { label: "Vercel", seeds: { bg: "#000000", fg: "#ededed", acc: "#006efe", con: c } },
];

export const getPresetsForMode = (mode: ThemeMode): readonly PresetDefinition[] =>
  mode === "light" ? LIGHT_PRESETS : DARK_PRESETS;

export const findMatchingPreset = (mode: ThemeMode, seeds: CustomSeeds): PresetDefinition | null =>
  getPresetsForMode(mode).find(
    (p) => p.seeds.bg === seeds.bg && p.seeds.fg === seeds.fg && p.seeds.acc === seeds.acc && p.seeds.con === seeds.con,
  ) ?? null;

export const DEFAULT_THEME_STATE: ThemeState = { light: DEFAULT_LIGHT_SEEDS, dark: DEFAULT_DARK_SEEDS };
export const getDefaultSeeds = (mode: ThemeMode): CustomSeeds =>
  mode === "light" ? DEFAULT_LIGHT_SEEDS : DEFAULT_DARK_SEEDS;
