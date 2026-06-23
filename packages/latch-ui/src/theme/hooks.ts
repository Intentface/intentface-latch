import { useTheme } from "next-themes";
import { useCallback, useEffect } from "react";
import {
  type CustomSeeds,
  findMatchingPreset,
  getDefaultSeeds,
  type PresetDefinition,
  type ThemeMode,
} from "./presets.js";
import { useSettingsStore } from "./store.js";

const CSS_VARS = [
  ["bg", "--bg"],
  ["fg", "--fg"],
  ["acc", "--acc"],
  ["con", "--con"],
] as const;

/** Perceived-luminance check on a #rgb/#rrggbb hex; true when the color is dark. */
const isDarkHex = (hex: string): boolean => {
  const h = hex.replace(/^#/, "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (v.length !== 6) return false;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};

/**
 * Applies the user's per-mode seed overrides to the document as CSS variables
 * (the whole palette recomputes from them in theme.css). Mount once near the
 * app root. Requires a next-themes provider above it.
 */
export const useThemeOverrides = (): void => {
  const { resolvedTheme } = useTheme();
  const themeOverrides = useSettingsStore((s) => s.themeOverrides);

  useEffect(() => {
    if (!resolvedTheme) return;
    const mode = (resolvedTheme === "dark" ? "dark" : "light") as ThemeMode;
    const overrides = themeOverrides[mode];
    const root = document.documentElement;
    const style = root.style;
    for (const [key, cssVar] of CSS_VARS) {
      const value = overrides[key];
      if (value !== undefined) style.setProperty(cssVar, String(value));
      else style.removeProperty(cssVar);
    }
    // The light/dark *formulas* in theme.css key off the `.dark` class, but the
    // effective background comes from the seeds — which can disagree (e.g. a
    // dark `--bg` chosen in light mode). If they desync, light-mode formulas run
    // on a dark canvas and the foreground (`--fg`) collides with the surfaces
    // (invisible card titles). Reconcile `.dark` to the actual background so the
    // matching formula set always runs.
    const bg = overrides.bg ?? getDefaultSeeds(mode).bg;
    root.classList.toggle("dark", isDarkHex(bg));
  }, [resolvedTheme, themeOverrides]);
};

export type InterfaceThemeMode = "light" | "dark" | "system";

export type UseInterfaceThemeResult = {
  mode: InterfaceThemeMode;
  resolvedMode: ThemeMode;
  setMode: (next: InterfaceThemeMode) => void;
  seeds: CustomSeeds;
  setSeed: <K extends keyof CustomSeeds>(key: K, value: CustomSeeds[K]) => void;
  preset: PresetDefinition | null;
  setPreset: (preset: PresetDefinition) => void;
  reset: () => void;
};

/** Customizer state: current mode, resolved seeds (defaults + overrides), and setters. */
export const useInterfaceTheme = (): UseInterfaceThemeResult => {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const themeOverrides = useSettingsStore((s) => s.themeOverrides);
  const setThemeOverride = useSettingsStore((s) => s.setThemeOverride);
  const setThemeOverrides = useSettingsStore((s) => s.setThemeOverrides);
  const resetThemeOverrides = useSettingsStore((s) => s.resetThemeOverrides);

  const mode = (theme ?? "system") as InterfaceThemeMode;
  const resolvedMode: ThemeMode = resolvedTheme === "dark" ? "dark" : "light";

  const defaults = getDefaultSeeds(resolvedMode);
  const overrides = themeOverrides[resolvedMode];
  const seeds: CustomSeeds = {
    bg: overrides.bg ?? defaults.bg,
    fg: overrides.fg ?? defaults.fg,
    acc: overrides.acc ?? defaults.acc,
    con: overrides.con ?? defaults.con,
  };

  const preset = findMatchingPreset(resolvedMode, seeds);

  const setMode = useCallback((next: InterfaceThemeMode) => setTheme(next), [setTheme]);
  const setSeed = useCallback(
    <K extends keyof CustomSeeds>(key: K, value: CustomSeeds[K]) => setThemeOverride(resolvedMode, key, value),
    [resolvedMode, setThemeOverride],
  );
  const setPreset = useCallback(
    (next: PresetDefinition) => setThemeOverrides(resolvedMode, next.seeds),
    [resolvedMode, setThemeOverrides],
  );
  const reset = useCallback(() => resetThemeOverrides(resolvedMode), [resolvedMode, resetThemeOverrides]);

  return { mode, resolvedMode, setMode, seeds, setSeed, preset, setPreset, reset };
};
