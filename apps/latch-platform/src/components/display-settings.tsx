/**
 * Display options — the theme seeds and the thread's reading behavior, in the
 * tabbed panel intentface-chat uses (a gear in the chat area's top-right).
 *
 * The panel content is exported on its own too, so the sidebar's Settings dialog
 * shows exactly the same controls instead of a second, divergent copy.
 */

import { Tabs } from "@base-ui/react/tabs"
import type { ReactNode } from "react"
import type { ThreadAutoScrollMode } from "@/components/ai/thread"
import { AppearanceIcon } from "@/components/icons/appearance"
import { MoonIcon } from "@/components/icons/moon"
import { SettingsIcon } from "@/components/icons/settings"
import { SettingsSliderThreeIcon } from "@/components/icons/settings-slider-three"
import { SquareLinesIcon } from "@/components/icons/square-lines"
import { SunIcon } from "@/components/icons/sun"
import { ColorPill } from "@/components/ui/color-pill"
import { IconButton } from "@/components/ui/icon-button"
import { Popover } from "@/components/ui/popover"
import { PresetSwatch } from "@/components/ui/preset-swatch"
import { Scaler } from "@/components/ui/scaler"
import Select from "@/components/ui/select-menu"
import { Settings } from "@/components/ui/settings"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup } from "@/components/ui/toggle-group"
import {
  
  useInterfaceTheme
} from "@/hooks/use-interface-theme"
import type {InterfaceThemeMode} from "@/hooks/use-interface-theme";
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  CONTRAST_STEP,
  getPresetsForMode,
} from "@/lib/interface-theme"
import { useSettingsStore } from "@/lib/store/settings"
import { cn } from "@/lib/utils"

// Right-aligned compact controls share one footprint across the rows.
const COMPACT_CONTROL_CLASS = "h-8 w-28 shrink-0"

const ROW_CLASS = "min-h-11 border-0 px-3 py-2"

/** Label (with optional description) and control on one row. */
const LabeledRow = ({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) => (
  <Settings.Row className={cn(ROW_CLASS, "items-center gap-3")}>
    <Settings.LabelGroup>
      <Settings.Label>{label}</Settings.Label>
      {description && (
        <Settings.Description>{description}</Settings.Description>
      )}
    </Settings.LabelGroup>
    <Settings.Control className="w-auto shrink-0">{children}</Settings.Control>
  </Settings.Row>
)

/** Inline boolean row. The label span carries no id, so the switch names itself. */
const ToggleRow = ({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) => (
  <Settings.Row className={cn(ROW_CLASS, "items-center gap-3")}>
    <Settings.LabelGroup>
      <Settings.Label>{label}</Settings.Label>
      {description && (
        <Settings.Description>{description}</Settings.Description>
      )}
    </Settings.LabelGroup>
    <Settings.Control className="w-auto shrink-0">
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </Settings.Control>
  </Settings.Row>
)

// ---------------------------------------------------------------------------
// Theme — seeds and presets, driven by use-interface-theme
// ---------------------------------------------------------------------------

const CUSTOM_PRESET_VALUE = "__custom__"

const MODE_OPTIONS: ReadonlyArray<{
  value: InterfaceThemeMode
  label: string
  Icon: typeof SunIcon
}> = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: AppearanceIcon },
]

const ThemeTab = () => {
  const { mode, resolvedMode, setMode, seeds, setSeed, preset, setPreset } =
    useInterfaceTheme()

  const presets = getPresetsForMode(resolvedMode)
  const selectedPresetValue = preset ? preset.label : CUSTOM_PRESET_VALUE

  return (
    <div className="py-1">
      <LabeledRow label="Mode" description="Light, dark, or follow the system">
        <ToggleGroup
          variant="segmented"
          value={mode}
          onValueChange={(next: InterfaceThemeMode | null) => {
            if (next) setMode(next)
          }}
          className="w-fit"
        >
          {MODE_OPTIONS.map(({ value, label, Icon }) => (
            <ToggleGroup.Item
              key={value}
              value={value}
              size="xs"
              aria-label={label}
            >
              <Icon className="size-3.5" />
            </ToggleGroup.Item>
          ))}
        </ToggleGroup>
      </LabeledRow>

      <LabeledRow label="Preset" description="Pick a starter palette">
        <Select
          value={selectedPresetValue}
          onValueChange={(value: string | null) => {
            if (!value || value === CUSTOM_PRESET_VALUE) return
            const next = presets.find((option) => option.label === value)
            if (next) setPreset(next)
          }}
        >
          <Select.Trigger
            className={cn(COMPACT_CONTROL_CLASS, "rounded-md px-1")}
            size="sm"
          >
            <Select.Value>
              <div className="flex items-center gap-2">
                <PresetSwatch seeds={seeds} />
                <span>{preset?.label ?? "Custom"}</span>
              </div>
            </Select.Value>
          </Select.Trigger>
          <Select.Content>
            {!preset && (
              <Select.Item value={CUSTOM_PRESET_VALUE}>
                <PresetSwatch seeds={seeds} />
                <span>Custom</span>
              </Select.Item>
            )}
            {presets.map((option) => (
              <Select.Item key={option.label} value={option.label}>
                <PresetSwatch seeds={option.seeds} />
                <span>{option.label}</span>
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </LabeledRow>

      <LabeledRow label="Accent" description="Buttons, links, and focus rings">
        <ColorPill
          size="compact"
          className={COMPACT_CONTROL_CLASS}
          value={seeds.acc}
          onValueChange={(value) => setSeed("acc", value)}
        />
      </LabeledRow>

      <LabeledRow label="Background" description="Workspace base color">
        <ColorPill
          size="compact"
          className={COMPACT_CONTROL_CLASS}
          value={seeds.bg}
          onValueChange={(value) => setSeed("bg", value)}
        />
      </LabeledRow>

      <LabeledRow label="Foreground" description="Workspace text color">
        <ColorPill
          size="compact"
          className={COMPACT_CONTROL_CLASS}
          value={seeds.fg}
          onValueChange={(value) => setSeed("fg", value)}
        />
      </LabeledRow>

      <LabeledRow label="Contrast" description="Surface elevation strength">
        <Scaler
          size="compact"
          className={COMPACT_CONTROL_CLASS}
          value={seeds.con}
          onValueChange={(value) => setSeed("con", value)}
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={CONTRAST_STEP}
          tickStep={0.05}
        />
      </LabeledRow>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread — how new turns land, and the thread's chrome
// ---------------------------------------------------------------------------

const SCROLL_MODE_OPTIONS: ReadonlyArray<{
  value: ThreadAutoScrollMode
  label: string
}> = [
  { value: "follow", label: "Follow" },
  { value: "jump", label: "Jump to top" },
  { value: "bottom", label: "Bottom" },
  { value: "off", label: "Off" },
]

const ThreadTab = () => {
  const scrollMode = useSettingsStore((state) => state.scrollMode)
  const setScrollMode = useSettingsStore((state) => state.setScrollMode)
  const stickyMessages = useSettingsStore((state) => state.stickyMessages)
  const setStickyMessages = useSettingsStore((state) => state.setStickyMessages)
  const showScrollButton = useSettingsStore((state) => state.showScrollButton)
  const setShowScrollButton = useSettingsStore(
    (state) => state.setShowScrollButton
  )
  const showOverlays = useSettingsStore((state) => state.showOverlays)
  const setShowOverlays = useSettingsStore((state) => state.setShowOverlays)

  return (
    <div className="py-1">
      <LabeledRow
        label="Auto-scroll"
        description="How new turns land and follow"
      >
        <Select
          value={scrollMode}
          onValueChange={(value: ThreadAutoScrollMode | null) => {
            if (value) setScrollMode(value)
          }}
        >
          <Select.Trigger
            className={cn(COMPACT_CONTROL_CLASS, "rounded-md")}
            size="sm"
          >
            <Select.Value>
              {
                SCROLL_MODE_OPTIONS.find(
                  (option) => option.value === scrollMode
                )?.label
              }
            </Select.Value>
          </Select.Trigger>
          <Select.Content>
            {SCROLL_MODE_OPTIONS.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                {option.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </LabeledRow>
      <ToggleRow
        label="Pinned questions"
        description="Keep each turn's question as a header"
        checked={stickyMessages}
        onCheckedChange={setStickyMessages}
      />
      <ToggleRow
        label="Scroll button"
        description="Jump-to-bottom affordance"
        checked={showScrollButton}
        onCheckedChange={setShowScrollButton}
      />
      <ToggleRow
        label="Edge fades"
        description="Top and bottom fade overlays"
        checked={showOverlays}
        onCheckedChange={setShowOverlays}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The tabbed panel, and the gear that floats it over the chat
// ---------------------------------------------------------------------------

const TABS = [
  {
    value: "theme",
    label: "Theme",
    Icon: SettingsSliderThreeIcon,
    content: <ThemeTab />,
  },
  {
    value: "thread",
    label: "Thread",
    Icon: SquareLinesIcon,
    content: <ThreadTab />,
  },
] as const

/** The panel on its own — for hosting inside a dialog. */
export const DisplaySettingsPanel = () => (
  <Tabs.Root defaultValue="theme">
    <Tabs.List className="flex gap-2 border-b border-primary-border p-2">
      {TABS.map((tab) => (
        <Tabs.Tab
          key={tab.value}
          value={tab.value}
          className={cn(
            "flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-transparent text-sm font-medium text-ink-secondary transition-colors outline-none",
            "hover:bg-primary-bg-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-accent-bg/50",
            "data-active:border-primary-border-active data-active:bg-primary-bg-active data-active:text-ink-primary",
            "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-ink-tertiary data-active:[&>svg]:text-ink-primary"
          )}
        >
          <tab.Icon />
          {tab.label}
        </Tabs.Tab>
      ))}
    </Tabs.List>
    {TABS.map((tab) => (
      <Tabs.Panel key={tab.value} value={tab.value}>
        {tab.content}
      </Tabs.Panel>
    ))}
  </Tabs.Root>
)

export const DisplaySettings = ({ className }: { className?: string }) => (
  <div
    data-slot="display-settings"
    className={cn("hidden md:block", className)}
  >
    <Popover>
      <Popover.Trigger
        render={
          <IconButton
            variant="primary"
            className="rounded-full"
            aria-label="Display settings"
          />
        }
      >
        <SettingsIcon className="size-4" />
      </Popover.Trigger>
      <Popover.Content align="end" sideOffset={4} className="w-80 p-0">
        <DisplaySettingsPanel />
      </Popover.Content>
    </Popover>
  </div>
)
