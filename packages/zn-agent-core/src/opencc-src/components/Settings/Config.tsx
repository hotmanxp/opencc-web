// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';
import { useState, useCallback } from 'react';
// React 19 `use()` — @types/react 18 doesn't declare it; preact-shim provides
// the runtime implementation (and its type) in the bundled build.
import { modelDisplayString } from '../../utils/model/model.js'
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js';
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  context: LocalJSXCommandContext;
  setTabsHidden: (hidden: boolean) => void;
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  contentHeight?: number;
};
type SettingBase = {
  id: string;
  label: string;
  description?: string;
} | {
  id: string;
  label: React.ReactNode;
  searchText: string;
  description?: string;
};
type Setting = (SettingBase & {
  value: boolean;
  onChange(value: boolean): void;
  type: 'boolean';
}) | (SettingBase & {
  value: string;
  options: string[];
  onChange(value: string): void;
  type: 'enum';
}) | (SettingBase & {
  // For enums that are set by a custom component, we don't need to pass options,
  // but we still need a value to display in the top-level config menu
  value: string;
  onChange(value: string): void;
  type: 'managedEnum';
});
type SubMenu = 'Theme' | 'Model' | 'TeammateModel' | 'CompactModel' | 'ExternalIncludes' | 'OutputStyle' | 'ChannelDowngrade' | 'Language' | 'EnableAutoUpdates' | 'AutoContinueTimeout';
export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight
}: Props): React.ReactNode | null {
  return null;
}
function teammateModelDisplayString(value: string | null | undefined): string {
  if (value === undefined) {
    return modelDisplayString(getHardcodedTeammateModelFallback());
  }
  if (value === null) return "Default (leader's model)";
  return modelDisplayString(value);
}
function compactModelDisplayString(value: string | undefined): string {
  if (value === undefined) return 'Default (main model)';
  return modelDisplayString(value);
}
const THEME_LABELS: Record<string, string> = {
  auto: 'Auto (match terminal)',
  dark: 'Dark mode',
  light: 'Light mode',
  'dark-daltonized': 'Dark mode (colorblind-friendly)',
  'light-daltonized': 'Light mode (colorblind-friendly)',
  'dark-ansi': 'Dark mode (ANSI colors only)',
  'light-ansi': 'Light mode (ANSI colors only)'
};
function NotifChannelLabel(t0) {
  return null;
}
