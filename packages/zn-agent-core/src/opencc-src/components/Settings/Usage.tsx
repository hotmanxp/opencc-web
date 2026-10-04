// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect, useState } from 'react';
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js';
import { formatCost, formatTotalCost } from 'src/cost-tracker.js';
import { getSubscriptionType } from 'src/utils/auth.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { type ExtraUsage, fetchUtilization, type RateLimit, type Utilization } from '../../services/api/usage.js';
import { formatResetText } from '../../utils/format.js';
import { logError } from '../../utils/log.js';
import { getAPIProvider } from '../../utils/model/providers.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline } from '../design-system/Byline.js';
import { ProgressBar } from '../design-system/ProgressBar.js';
import { isEligibleForOverageCreditGrant, OverageCreditUpsell } from '../LogoV2/OverageCreditUpsell.js';
import { MiniMaxUsage } from './MiniMaxUsage.js';
import { UnsupportedUsage } from './UnsupportedUsage.js';
type LimitBarProps = {
  title: string;
  limit: RateLimit;
  maxWidth: number;
  showTimeInReset?: boolean;
  extraSubtext?: string;
};
function LimitBar(t0) {
  return null;
}
function AnthropicUsage(): React.ReactNode | null {
  return null;
}
export function Usage(): React.ReactNode | null {
  return null;
}
type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage;
  maxWidth: number;
};
const EXTRA_USAGE_SECTION_TITLE = 'Extra usage';
function ExtraUsageSection(t0) {
  return null;
}
