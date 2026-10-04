// @ts-nocheck
import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { logEvent } from '../../services/analytics/index.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
type DesktopUpsellConfig = {
  enable_shortcut_tip: boolean;
  enable_startup_dialog: boolean;
};
const DESKTOP_UPSELL_DEFAULT: DesktopUpsellConfig = {
  enable_shortcut_tip: false,
  enable_startup_dialog: false
};
export function getDesktopUpsellConfig(): DesktopUpsellConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE('tengu_desktop_upsell', DESKTOP_UPSELL_DEFAULT);
}
function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32' && process.arch === 'x64';
}
export function shouldShowDesktopUpsellStartup(): boolean {
  if (!isSupportedPlatform()) return false;
  if (!getDesktopUpsellConfig().enable_startup_dialog) return false;
  const config = getGlobalConfig();
  if (config.desktopUpsellDismissed) return false;
  if ((config.desktopUpsellSeenCount ?? 0) >= 3) return false;
  return true;
}
type DesktopUpsellSelection = 'try' | 'not-now' | 'never';
type Props = {
  onDone: () => void;
};
export function DesktopUpsellStartup(t0) {
  return null;
}
function _temp2(prev_0) {
  if (prev_0.desktopUpsellDismissed) {
    return prev_0;
  }
  return {
    ...prev_0,
    desktopUpsellDismissed: true
  };
}
function _temp() {
  const newCount = (getGlobalConfig().desktopUpsellSeenCount ?? 0) + 1;
  saveGlobalConfig(prev => {
    if ((prev.desktopUpsellSeenCount ?? 0) >= newCount) {
      return prev;
    }
    return {
      ...prev,
      desktopUpsellSeenCount: newCount
    };
  });
  logEvent("tengu_desktop_upsell_shown", {
    seen_count: newCount
  });
}
