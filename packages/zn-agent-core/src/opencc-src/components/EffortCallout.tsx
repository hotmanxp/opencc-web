// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { useCallback, useEffect, useRef } from 'react';
import { Box, Text } from '../ink.js';
import { isMaxSubscriber, isProSubscriber, isTeamSubscriber } from '../utils/auth.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { EffortLevel } from '../utils/effort.js';
import { convertEffortValueToLevel, getDefaultEffortForModel, getOpusDefaultEffortConfig, modelSupportsUltracode, toPersistableEffort } from '../utils/effort.js';
import { isWorkflowsDisabled } from '../utils/envUtils.js';
import { isUltracodeActive } from '../utils/ultracode.js';
import { parseUserSpecifiedModel } from '../utils/model/model.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';

/**
 * Pure helper that returns the option list shown by EffortCallout.
 *
 * Mirrors the upstream claude-code v2.1.170 behavior: when workflows are
 * enabled AND the model supports ultracode AND ultracode is not already
 * active, surface "Ultracode" as a recommended option. Otherwise show
 * the standard low / medium / high trio with "Medium (recommended)".
 *
 * Exported separately from the component so unit tests can verify the
 * gating conditions without rendering the Ink tree.
 */
export type EffortCalloutOptionValue = EffortLevel | 'dismiss'

export function getEffortCalloutOptions(
  model: string,
  opts: { ultracodeActive?: boolean } = {},
): { value: EffortCalloutOptionValue; recommended: boolean }[] {
  const ultracodeAlreadyOn = opts.ultracodeActive ?? isUltracodeActive()
  const canRecommendUltracode =
    !isWorkflowsDisabled() && modelSupportsUltracode(model) && !ultracodeAlreadyOn

  const options: { value: EffortCalloutOptionValue; recommended: boolean }[] = []
  if (canRecommendUltracode) {
    options.push({ value: 'ultracode', recommended: true })
  }
  options.push(
    { value: 'medium', recommended: !canRecommendUltracode },
    { value: 'high', recommended: false },
    { value: 'low', recommended: false },
  )
  return options
}
type EffortCalloutSelection = EffortLevel | undefined | 'dismiss';
type Props = {
  model: string;
  onDone: (selection: EffortCalloutSelection) => void;
};
const AUTO_DISMISS_MS = 30_000;
export function EffortCallout(t0) {
  return null;
}
function _temp() {
  markV2Dismissed();
}
function EffortIndicatorSymbol(t0) {
  return null;
}
function EffortOptionLabel(t0) {
  return null;
}

/**
 * Human-readable label for each effort option. Matches the historical
 * copy in the upstream callout: capitalized level name with "Ultracode"
 * kept as a single word. "(recommended)" is appended by the caller.
 */
function labelForLevel(value: EffortLevel): string {
  if (value === 'ultracode') return 'Ultracode'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Check whether to show the effort callout.
 *
 * Audience:
 * - Pro: already had medium default; show unless they saw v1 (effortCalloutDismissed)
 * - Max/Team: getting medium via tengu_grey_step2 config; show when enabled
 * - Everyone else: mark as dismissed so it never shows
 */
export function shouldShowEffortCallout(model: string): boolean {
  // Only show for Opus 4.6 for now
  const parsed = parseUserSpecifiedModel(model);
  if (!parsed.toLowerCase().includes('opus-4-6')) {
    return false;
  }
  const config = getGlobalConfig();
  if (config.effortCalloutV2Dismissed) return false;

  // Don't show to brand-new users — they never knew the old default, so this
  // isn't a change for them. Mark as dismissed so it stays suppressed.
  if (config.numStartups <= 1) {
    markV2Dismissed();
    return false;
  }

  // Pro users already had medium default before this PR. Show the new copy,
  // but skip if they already saw the v1 dialog — no point nagging twice.
  if (isProSubscriber()) {
    if (config.effortCalloutDismissed) {
      markV2Dismissed();
      return false;
    }
    return getOpusDefaultEffortConfig().enabled;
  }

  // Max/Team are the target of the tengu_grey_step2 config.
  // Don't mark dismissed when config is disabled — they should see the dialog
  // once it's enabled for them.
  if (isMaxSubscriber() || isTeamSubscriber()) {
    return getOpusDefaultEffortConfig().enabled;
  }

  // Everyone else (free tier, API key, non-subscribers): not in scope.
  markV2Dismissed();
  return false;
}
function markV2Dismissed(): void {
  saveGlobalConfig(current => {
    if (current.effortCalloutV2Dismissed) return current;
    return {
      ...current,
      effortCalloutV2Dismissed: true
    };
  });
}
