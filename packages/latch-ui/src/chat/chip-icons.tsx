import type { ReactNode } from "react";
import {
  BrainIcon,
  BubbleWideSparkleIcon,
  CodeIcon,
  FileChartIcon,
  FileTextIcon,
  GlobeIcon,
  ImageAltIcon,
  SpreadsheetIcon,
} from "./icons.js";

export const CHIP_ICONS = {
  brain: <BrainIcon />,
  bubbleWideSparkle: <BubbleWideSparkleIcon />,
  code: <CodeIcon />,
  fileChart: <FileChartIcon />,
  fileText: <FileTextIcon />,
  globe: <GlobeIcon />,
  imageAlt: <ImageAltIcon />,
  spreadsheet: <SpreadsheetIcon />,
} satisfies Record<string, ReactNode>;

export type ChipIconKey = keyof typeof CHIP_ICONS;
