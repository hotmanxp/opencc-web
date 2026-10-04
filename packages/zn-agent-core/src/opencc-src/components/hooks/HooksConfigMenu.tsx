// @ts-nocheck
/**
 * HooksConfigMenu is a read-only browser for configured hooks.
 *
 * Users can drill into each hook event, see configured matchers and hooks
 * (of any type: command, prompt, agent, http), and view individual hook
 * details. To add or modify hooks, users should edit settings.json directly
 * or ask OpenCC — the menu directs them there.
 *
 * The menu is read-only because the old editing UI only supported
 * command-type hooks and duplicating the settings.json editing surface
 * in-menu for all four types would be a maintenance burden.
 */
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { CommandResultDisplay } from '../../commands.js';
import { Text } from '../../ink.js'
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { getSettings_DEPRECATED, getSettingsForSource } from '../../utils/settings/settings.js';
type Props = {
  toolNames: string[];
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
type ModeState = {
  mode: 'select-event';
} | {
  mode: 'select-matcher';
  event: HookEvent;
} | {
  mode: 'select-hook';
  event: HookEvent;
  matcher: string;
} | {
  mode: 'view-hook';
  event: HookEvent;
  hook: IndividualHookConfig;
};
export function HooksConfigMenu(t0) {
  return null;
}
function _temp6() {
  return <Text>Esc to close</Text>;
}
function _temp5(sum: number, hooks: IndividualHookConfig[]): number {
  return sum + hooks.length;
}
function _temp4(tool) {
  return tool.name;
}
function _temp3(s) {
  return s.mcp;
}
function _temp2() {
  return getSettingsForSource("policySettings")?.allowManagedHooksOnly === true;
}
function _temp() {
  const settings = getSettings_DEPRECATED();
  const hooksDisabled = settings?.disableAllHooks === true;
  return hooksDisabled && getSettingsForSource("policySettings")?.disableAllHooks === true;
}
