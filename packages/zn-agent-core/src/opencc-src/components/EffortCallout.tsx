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
  const $ = _c(19);
  const {
    model,
    onDone
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getOpusDefaultEffortConfig();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const defaultEffortConfig = t1;
  const onDoneRef = useRef(onDone);
  let t2;
  if ($[1] !== onDone) {
    t2 = () => {
      onDoneRef.current = onDone;
    };
    $[1] = onDone;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  useEffect(t2);
  let t3;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = () => {
      onDoneRef.current("dismiss");
    };
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const handleCancel = t3;
  let t4;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [];
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  useEffect(_temp, t4);
  let t5;
  let t6;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = () => {
      const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS);
      return () => clearTimeout(timeoutId);
    };
    t6 = [handleCancel];
    $[5] = t5;
    $[6] = t6;
  } else {
    t5 = $[5];
    t6 = $[6];
  }
  useEffect(t5, t6);
  let t7;
  if ($[7] !== model) {
    const defaultEffort = getDefaultEffortForModel(model);
    t7 = defaultEffort ? convertEffortValueToLevel(defaultEffort) : "high";
    $[7] = model;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  const defaultLevel = t7;
  let t8;
  if ($[9] !== defaultLevel) {
    t8 = value => {
      // Ultracode is a session-level toggle, not a persisted effortLevel.
      // Match plan9's /effort ultracode path: write settings.ultracode=true
      // and surface the choice via onDone so the AppState reflects it.
      if (value === "ultracode") {
        updateSettingsForSource("userSettings", { ultracode: true });
        onDoneRef.current(value);
        return;
      }
      const effortLevel = value === defaultLevel ? undefined : value;
      updateSettingsForSource("userSettings", {
        effortLevel: toPersistableEffort(effortLevel)
      });
      onDoneRef.current(value);
    };
    $[9] = defaultLevel;
    $[10] = t8;
  } else {
    t8 = $[10];
  }
  const handleSelect = t8;
  let t9;
  if ($[11] !== model) {
    t9 = getEffortCalloutOptions(model).map(o => ({
      label: <EffortOptionLabel level={o.value as EffortLevel} text={o.recommended ? `${labelForLevel(o.value)} (recommended)` : labelForLevel(o.value)} />,
      value: o.value
    }));
    $[11] = model;
    $[12] = t9;
  } else {
    t9 = $[12];
  }
  const options = t9;
  let t10;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t10 = <Box marginBottom={1} flexDirection="column"><Text>{defaultEffortConfig.dialogDescription}</Text></Box>;
    $[13] = t10;
  } else {
    t10 = $[13];
  }
  let t11;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t11 = <EffortIndicatorSymbol level="low" />;
    $[14] = t11;
  } else {
    t11 = $[14];
  }
  let t12;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    t12 = <EffortIndicatorSymbol level="medium" />;
    $[15] = t12;
  } else {
    t12 = $[15];
  }
  let t13;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = <Box marginBottom={1}><Text dimColor={true}>{t11} low {"\xB7"}{" "}{t12} medium {"\xB7"}{" "}<EffortIndicatorSymbol level="high" /> high</Text></Box>;
    $[16] = t13;
  } else {
    t13 = $[16];
  }
  let t14;
  if ($[17] !== handleSelect) {
    t14 = <PermissionDialog title={defaultEffortConfig.dialogTitle}><Box flexDirection="column" paddingX={2} paddingY={1}>{t10}{t13}<Select options={options} onChange={handleSelect} onCancel={handleCancel} /></Box></PermissionDialog>;
    $[17] = handleSelect;
    $[18] = t14;
  } else {
    t14 = $[18];
  }
  return t14;
}
function _temp() {
  markV2Dismissed();
}
function EffortIndicatorSymbol(t0) {
  const $ = _c(4);
  const {
    level
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = effortLevelToSymbol(level);
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1) {
    t2 = <Text color="suggestion">{t1}</Text>;
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return t2;
}
function EffortOptionLabel(t0) {
  const $ = _c(5);
  const {
    level,
    text
  } = t0;
  let t1;
  if ($[0] !== level) {
    t1 = <EffortIndicatorSymbol level={level} />;
    $[0] = level;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  let t2;
  if ($[2] !== t1 || $[3] !== text) {
    t2 = <>{t1} {text}</>;
    $[2] = t1;
    $[3] = text;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  return t2;
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
