/**
 * Persisted UI settings — the theme seeds the user customized, plus the thread's
 * reading preferences. localStorage-backed, so they survive reloads.
 *
 * The key is `latch-settings`: it predates this store, and keeping it means
 * existing preferences carry over rather than silently resetting.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ThreadAutoScrollMode } from "@/components/ai/thread"

type ThemeOverrides = {
  bg?: string
  fg?: string
  acc?: string
  con?: number
}

type ThemeMode = "light" | "dark"

type SettingsStore = {
  themeOverrides: Record<ThemeMode, ThemeOverrides>
  setThemeOverride: (
    mode: ThemeMode,
    key: keyof ThemeOverrides,
    value: string | number
  ) => void
  setThemeOverrides: (mode: ThemeMode, overrides: ThemeOverrides) => void
  resetThemeOverrides: (mode: ThemeMode) => void
  scrollMode: ThreadAutoScrollMode
  setScrollMode: (mode: ThreadAutoScrollMode) => void
  /** Pin each turn's user message as a section header while it scrolls. */
  stickyMessages: boolean
  setStickyMessages: (stickyMessages: boolean) => void
  showScrollButton: boolean
  setShowScrollButton: (showScrollButton: boolean) => void
  showOverlays: boolean
  setShowOverlays: (showOverlays: boolean) => void
}

export type { ThemeOverrides, ThemeMode }

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      themeOverrides: { light: {}, dark: {} },
      scrollMode: "follow",
      setScrollMode: (mode) => set({ scrollMode: mode }),
      stickyMessages: false,
      setStickyMessages: (stickyMessages) => set({ stickyMessages }),
      showScrollButton: true,
      setShowScrollButton: (showScrollButton) => set({ showScrollButton }),
      showOverlays: true,
      setShowOverlays: (showOverlays) => set({ showOverlays }),
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
    { name: "latch-settings" }
  )
)
