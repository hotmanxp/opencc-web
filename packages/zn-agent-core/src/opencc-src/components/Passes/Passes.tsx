// @ts-nocheck
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { setClipboard } from '../../ink/termio/osc.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to copy link
import { Box, Link, Text, useInput } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import { fetchReferralRedemptions, formatCreditAmount, getCachedOrFetchPassesEligibility } from '../../services/api/referral.js';
import type { ReferralRedemptionsResponse, ReferrerRewardInfo } from '../../services/oauth/types.js';
import { count } from '../../utils/array.js';
import { logError } from '../../utils/log.js';
import { Pane } from '../design-system/Pane.js';
type PassStatus = {
  passNumber: number;
  isAvailable: boolean;
};
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function Passes({
  onDone
}: Props): React.ReactNode | null {
  return null;
}
