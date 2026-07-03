/**
 * Pick text that contrasts a fill color — near-white on a dark fill, near-black
 * on a light one (OKLab lightness, threshold ≈0.62). Used to derive the
 * `--accent-foreground` / `--primary-foreground` tokens at runtime, since CSS
 * relative-color `calc()` on channels doesn't evaluate reliably across browsers.
 */

/** Parse `#rgb`/`#rrggbb` or `rgb()`/`rgba()` → [r,g,b] (0–255), else null. */
export function toRgb(color: string): [number, number, number] | null {
  const s = color.trim();
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length < 6) return null;
    const n = Number.parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Contrast-aware text color (oklch string) for a given fill color. */
export function onFill(color: string): string {
  const rgb = toRgb(color);
  if (!rgb) return "oklch(0.985 0 0)"; // unknown → assume dark fill → light text
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = rgb.map((c) => lin(c / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936178 * m - 0.0040720468 * s;
  return L < 0.62 ? "oklch(0.985 0 0)" : "oklch(0.18 0 0)";
}
