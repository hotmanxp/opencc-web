import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import type { ThemeSetting } from '../utils/theme.js';
import { StructuredDiff } from './StructuredDiff.js';

type StructuredDiffComponent = React.ComponentType<{
  patch: StructuredPatchHunk
  dim: boolean
  filePath: string
  firstLine: string | null
  width: number
  skipHighlighting?: boolean
}>
const StructuredDiffView = StructuredDiff as StructuredDiffComponent

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void;
  showIntroText?: boolean;
  helpText?: string;
  showHelpTextBelow?: boolean;
  hideEscToCancel?: boolean;
  /** Skip exit handling when running in a context that already has it (e.g., onboarding) */
  skipExitHandling?: boolean;
  /** Called when the user cancels (presses Escape). If skipExitHandling is true and this is provided, it will be called instead of just saving the preview. */
  onCancel?: () => void;
}

const DEMO_PATCH: StructuredPatchHunk = {
  oldStart: 1,
  newStart: 1,
  oldLines: 3,
  newLines: 3,
  lines: [
    ' function greet() {',
    '-  console.log("Hello, World!");',
    '+  console.log("Hello, OpenCC!");',
    ' }',
  ],
}

/**
 * Theme chooser with live preview. Implemented without react-compiler `_c` memo
 * caches so preview/subtree reconciliation cannot stick on stale element refs when
 * `setPreviewTheme` updates the resolved palette.
 */
export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
}: ThemePickerProps) {
  return null;
}
