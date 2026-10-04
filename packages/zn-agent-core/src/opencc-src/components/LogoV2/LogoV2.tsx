// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import * as React from 'react';

// Conditional require so ChannelsNotice.tsx tree-shakes when both flags are
// false. A module-scope helper component inside a feature() ternary does NOT
// tree-shake (docs/feature-gating.md); the require pattern eliminates the
// whole file. VoiceModeNotice uses the unsafe helper pattern but VOICE_MODE
// is external: true so it's moot there.
/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule = false || false ? require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
const LEFT_PANEL_MAX_WIDTH = 50;
export function LogoV2() {
  return null;
}
function _temp3(current) {
  if (current.lastReleaseNotesSeen === MACRO.VERSION) {
    return current;
  }
  return {
    ...current,
    lastReleaseNotesSeen: MACRO.VERSION
  };
}
function _temp2(s_0) {
  return s_0.effortValue;
}
function _temp(s) {
  return s.agent;
}
