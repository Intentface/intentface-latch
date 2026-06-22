import { HexColorPicker } from "react-colorful";
import { cn } from "../lib/utils.js";
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  CONTRAST_STEP,
  type CustomSeeds,
  getPresetsForMode,
} from "./presets.js";
import { type InterfaceThemeMode, useInterfaceTheme } from "./hooks.js";

/**
 * Live theme customizer (ported from intentface-chat): mode (light/dark/system),
 * presets, the three seed colors (bg/fg/acc) via react-colorful, and a contrast
 * slider. Everything derives from the seeds in theme.css, so edits apply
 * instantly via the override hook. Self-contained (token-styled), so it drops
 * into any host without extra primitives.
 */
const MODES: InterfaceThemeMode[] = ["light", "dark", "system"];
const SEED_LABELS: { key: keyof CustomSeeds; label: string }[] = [
  { key: "bg", label: "Background" },
  { key: "fg", label: "Foreground" },
  { key: "acc", label: "Accent" },
];

export function ThemeCustomizer({ className }: { className?: string }) {
  const { mode, resolvedMode, setMode, seeds, setSeed, preset, setPreset, reset } =
    useInterfaceTheme();
  const presets = getPresetsForMode(resolvedMode);

  return (
    <div className={cn("flex w-72 flex-col gap-4 text-sm", className)}>
      {/* Mode */}
      <Field label="Mode">
        <div className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-md border px-2 py-1 text-xs capitalize transition-colors",
                mode === m
                  ? "border-accent-border bg-accent text-white"
                  : "border-primary-border bg-primary text-ink-secondary hover:bg-primary-hover",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </Field>

      {/* Presets */}
      <Field label="Preset">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPreset(p)}
              title={p.label}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                preset?.label === p.label
                  ? "border-accent-border text-ink-primary"
                  : "border-primary-border text-ink-secondary hover:bg-primary-hover",
              )}
            >
              <span className="flex">
                <Swatch color={p.seeds.bg} />
                <Swatch color={p.seeds.acc} className="-ml-1" />
              </span>
              {p.label}
            </button>
          ))}
        </div>
      </Field>

      {/* Seed colors */}
      {SEED_LABELS.map(({ key, label }) => (
        <Field key={key} label={label}>
          <div className="flex items-start gap-3">
            <HexColorPicker
              color={seeds[key] as string}
              onChange={(value) => setSeed(key, value as never)}
              style={{ width: 120, height: 90 }}
            />
            <input
              value={seeds[key] as string}
              onChange={(e) => setSeed(key, e.target.value as never)}
              className="border-primary-border bg-primary text-ink-primary h-7 w-24 rounded-md border px-2 font-mono text-xs"
            />
          </div>
        </Field>
      ))}

      {/* Contrast */}
      <Field label={`Contrast (${seeds.con.toFixed(2)})`}>
        <input
          type="range"
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={CONTRAST_STEP}
          value={seeds.con}
          onChange={(e) => setSeed("con", Number(e.target.value) as never)}
          className="accent-accent w-full"
        />
      </Field>

      <button
        type="button"
        onClick={reset}
        className="border-primary-border text-ink-secondary hover:bg-primary-hover self-start rounded-md border px-2 py-1 text-xs"
      >
        Reset to default
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ink-tertiary text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("border-primary-border size-3.5 rounded-full border", className)}
      style={{ backgroundColor: color }}
    />
  );
}
