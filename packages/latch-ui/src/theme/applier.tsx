import { useThemeOverrides } from "./hooks.js";

/**
 * Mount once inside the next-themes provider. Applies the user's persisted seed
 * overrides to the document as CSS variables (renders nothing).
 */
export function ThemeOverridesApplier(): null {
  useThemeOverrides();
  return null;
}
