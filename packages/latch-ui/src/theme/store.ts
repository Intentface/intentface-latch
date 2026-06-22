import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThemeMode } from "./presets.js";

/** Thread auto-scroll behavior (mirrors the Thread component's modes). */
export type ThreadAutoScrollMode = "off" | "bottom" | "jump" | "follow";

export type ThemeOverrides = { bg?: string; fg?: string; acc?: string; con?: number };

type SettingsStore = {
  themeOverrides: Record<ThemeMode, ThemeOverrides>;
  setThemeOverride: (mode: ThemeMode, key: keyof ThemeOverrides, value: string | number) => void;
  setThemeOverrides: (mode: ThemeMode, overrides: ThemeOverrides) => void;
  resetThemeOverrides: (mode: ThemeMode) => void;
  scrollMode: ThreadAutoScrollMode;
  setScrollMode: (mode: ThreadAutoScrollMode) => void;
  stickyMessages: boolean;
  setStickyMessages: (stickyMessages: boolean) => void;
};

/** Persisted UI settings (theme overrides + thread prefs), localStorage-backed. */
export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      themeOverrides: { light: {}, dark: {} },
      scrollMode: "follow",
      setScrollMode: (mode) => set({ scrollMode: mode }),
      stickyMessages: false,
      setStickyMessages: (stickyMessages) => set({ stickyMessages }),
      setThemeOverride: (mode, key, value) =>
        set((state) => ({
          themeOverrides: {
            ...state.themeOverrides,
            [mode]: { ...state.themeOverrides[mode], [key]: value },
          },
        })),
      setThemeOverrides: (mode, overrides) =>
        set((state) => ({
          themeOverrides: { ...state.themeOverrides, [mode]: overrides },
        })),
      resetThemeOverrides: (mode) =>
        set((state) => ({
          themeOverrides: { ...state.themeOverrides, [mode]: {} },
        })),
    }),
    { name: "latch-settings" },
  ),
);
