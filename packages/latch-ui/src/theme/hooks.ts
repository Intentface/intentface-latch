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
    const style = document.documentElement.style;
    for (const [key, cssVar] of CSS_VARS) {
      const value = overrides[key];
      if (value !== undefined) style.setProperty(cssVar, String(value));
      else style.removeProperty(cssVar);
    }
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
