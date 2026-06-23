import { type ReactNode, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "../lib/utils.js";
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  CONTRAST_STEP,
  type CustomSeeds,
  getPresetsForMode,
} from "./presets.js";
import { type InterfaceThemeMode, useInterfaceTheme } from "./hooks.js";
import { Scaler } from "../shell/scaler.js";

/**
 * Live theme customizer in intentface-chat's row-based "Settings" layout: mode
 * toggle group, preset select, accent/background/foreground color pills (click
 * to reveal a picker), and a contrast slider. Everything derives from the seeds
 * in theme.css, so edits apply instantly.
 */
const MODES = [
  { v: "light", Icon: Sun },
  { v: "dark", Icon: Moon },
  { v: "system", Icon: Monitor },
] as const;

const COLORS: { key: keyof CustomSeeds; label: string; desc: string }[] = [
  { key: "acc", label: "Accent", desc: "Buttons, links, focus" },
  { key: "bg", label: "Background", desc: "Workspace base color" },
  { key: "fg", label: "Foreground", desc: "Workspace text color" },
];

export function ThemeCustomizer({ className }: { className?: string }) {
  const { mode, resolvedMode, setMode, seeds, setSeed, preset, setPreset, reset } =
    useInterfaceTheme();
  const presets = getPresetsForMode(resolvedMode);
  const [openColor, setOpenColor] = useState<keyof CustomSeeds | null>(null);

  return (
    <div className={cn("w-80 text-sm", className)}>
      <div className="mb-3 flex items-start justify-between">
        <div>
          <p className="text-ink-primary font-medium">Theme</p>
          <p className="text-ink-tertiary text-xs">Customize the workspace appearance</p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="text-ink-tertiary hover:text-ink-primary text-xs underline"
        >
          Reset
        </button>
      </div>

      <div className="border-primary-border divide-primary-border flex flex-col divide-y rounded-lg border">
        <Row label="Mode" desc="Light, dark, or system">
          <div className="bg-tertiary flex gap-0.5 rounded-md p-0.5">
            {MODES.map(({ v, Icon }) => (
              <button
                key={v}
                type="button"
                onClick={() => setMode(v as InterfaceThemeMode)}
                className={cn(
                  "flex items-center gap-1 rounded px-1.5 py-1 text-xs capitalize transition-colors",
                  mode === v
                    ? "bg-secondary text-ink-primary shadow-sm"
                    : "text-ink-secondary hover:text-ink-primary",
                )}
              >
                <Icon className="size-3.5" />
                {v}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Preset" desc="Pick a starter palette">
          <div className="flex items-center gap-2">
            <Swatch seeds={seeds} />
            <select
              value={preset?.label ?? "__custom__"}
              onChange={(e) => {
                const p = presets.find((x) => x.label === e.target.value);
                if (p) setPreset(p);
              }}
              className="border-primary-border bg-secondary text-ink-primary h-8 rounded-md border px-2 text-xs"
            >
              {!preset && <option value="__custom__">Custom</option>}
              {presets.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </Row>

        {COLORS.map(({ key, label, desc }) => (
          <Row key={key} label={label} desc={desc}>
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenColor((o) => (o === key ? null : key))}
                className="border-primary-border hover:bg-primary-hover flex items-center gap-2 rounded-md border px-2 py-1"
              >
                <span
                  className="border-primary-border size-4 rounded-full border"
                  style={{ backgroundColor: seeds[key] as string }}
                />
                <span className="font-mono text-xs">{seeds[key]}</span>
              </button>
              {openColor === key && (
                <div className="border-primary-border bg-primary absolute right-0 z-10 mt-1 rounded-lg border p-2 shadow-lg">
                  <HexColorPicker
                    color={seeds[key] as string}
                    onChange={(v) => setSeed(key, v as never)}
                    style={{ width: 168, height: 120 }}
                  />
                </div>
              )}
            </div>
          </Row>
        ))}

        <Row label="Contrast" desc="Surface elevation strength">
          <Scaler
            className="w-56"
            min={CONTRAST_MIN}
            max={CONTRAST_MAX}
            step={CONTRAST_STEP}
            tickStep={(CONTRAST_MAX - CONTRAST_MIN) / 8}
            value={seeds.con}
            onValueChange={(v) => setSeed("con", v as never)}
          />
        </Row>
      </div>
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-ink-primary text-xs font-medium">{label}</p>
        <p className="text-ink-tertiary text-[11px]">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Swatch({ seeds }: { seeds: CustomSeeds }) {
  return (
    <span className="flex">
      <span className="border-primary-border size-4 rounded-full border" style={{ backgroundColor: seeds.bg }} />
      <span className="border-primary-border -ml-1.5 size-4 rounded-full border" style={{ backgroundColor: seeds.acc }} />
    </span>
  );
}
