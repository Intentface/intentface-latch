import { useEffect } from "react";
import { onFill } from "@/lib/contrast";

/**
 * Keeps `--accent-foreground` / `--primary-foreground` in sync with the live
 * accent (`--acc`) and surface (`--bg`) seeds, so text placed ON those fills
 * (filled buttons, selected items, badges) always contrasts — the missing half
 * of the shadcn-style fg/bg token pair. Computed in JS because relative-color
 * CSS doesn't evaluate reliably. Mount once at the app root.
 *
 * Reacts to dark-mode toggles and live customizer edits via a MutationObserver
 * on `<html>`'s class/style; guarded so writing the vars doesn't re-trigger it.
 */
export function ThemeContrast() {
  useEffect(() => {
    const root = document.documentElement;
    let lastAcc = "";
    let lastBg = "";
    const apply = () => {
      const cs = getComputedStyle(root);
      const acc = cs.getPropertyValue("--acc").trim() || cs.getPropertyValue("--accent").trim();
      const bg = cs.getPropertyValue("--bg").trim();
      if (acc === lastAcc && bg === lastBg) return; // no seed change → avoid loop
      lastAcc = acc;
      lastBg = bg;
      if (acc) root.style.setProperty("--accent-foreground", onFill(acc));
      if (bg) root.style.setProperty("--primary-foreground", onFill(bg));
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
    return () => obs.disconnect();
  }, []);
  return null;
}
