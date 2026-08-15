import { useThemeOverrides } from "@/hooks/use-theme-overrides"

/**
 * Applies the user's persisted seed overrides (`--bg`, `--fg`, `--acc`, `--con`)
 * to the document, which is all it takes for the whole OKLCH palette in
 * styles.css to recompute. Mount once inside the next-themes provider; renders
 * nothing.
 */
export function ThemeOverridesApplier(): null {
  useThemeOverrides()
  return null
}
