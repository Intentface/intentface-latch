# @intentface/latch-ui

The chat UI toolkit for Latch — chat components, a theme, and primitives (base-ui + Tailwind v4), ported from intentface-chat. Router-agnostic (inject navigation; no `next/*` or TanStack imports inside the package).

## What it does

- **Chat** — `Thread`, `Message` (streamdown markdown, reasoning, sources, actions, a `Steps` tool timeline), the tiptap `Composer` (input, attachments, commands), `Steps`, `Reasoning`, `StepQueue`, `TextShimmer`. `Message` takes `renderApproval` / `renderSubagent` slots so the host wires our approval/connect/subagent surfaces.
- **Primitives** (`components/ui/*`) — base-ui-backed button, input, textarea, select, dialog, popover, dropdown, switch, card, badge, etc. + `cn()`.
- **Shell** — sidebar, theme switch, and a live theme customizer (OKLCH tokens + presets).
- **Theme** — `theme.css` (exported subpath): the OKLCH seed tokens + light/dark + `@custom-variant dark`. The consuming app `@import`s it and adds `@source` so Tailwind scans the package's classes.

## Usage

```ts
import { Thread, Composer, Message } from "@intentface/latch-ui";
// app styles.css:
//   @import "@intentface/latch-ui/theme.css";
//   @source "../node_modules/@intentface/latch-ui/dist";
```

## Where it fits

The frontend layer. It renders generic AI-SDK UIMessage parts; the app wires them to the Latch handler (`useChat` transport, approvals, `connect_` OAuth, history). Backend behavior comes from `@intentface/latch-*`.
