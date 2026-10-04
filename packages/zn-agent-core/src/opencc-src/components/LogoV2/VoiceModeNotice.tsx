// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import { useEffect, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js';
import { AnimatedAsterisk } from './AnimatedAsterisk.js';
import { shouldShowOpus1mMergeNotice } from './Opus1mMergeNotice.js';
const MAX_SHOW_COUNT = 3;
export function VoiceModeNotice() {
  return null;
}
function VoiceModeNoticeInner() {
  return null;
}
function _temp() {
  return isVoiceModeEnabled() && getInitialSettings().voiceEnabled !== true && (getGlobalConfig().voiceNoticeSeenCount ?? 0) < MAX_SHOW_COUNT && !shouldShowOpus1mMergeNotice();
}
