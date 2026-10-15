import * as React from 'react';
import { useEffect, useMemo } from 'react';
import { getDynamicConfig_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
const CONFIG_NAME = 'tengu-top-of-feed-tip';
export function EmergencyTip(): React.ReactNode | null {
  return null;
}
type TipOfFeed = {
  tip: string;
  color?: 'dim' | 'warning' | 'error';
};
const DEFAULT_TIP: TipOfFeed = {
  tip: '',
  color: 'dim'
};

/**
 * Get the tip of the feed from dynamic config with caching
 * Returns cached value immediately, updates in background
 */
function getTipOfFeed(): TipOfFeed {
  return getDynamicConfig_CACHED_MAY_BE_STALE<TipOfFeed>(CONFIG_NAME, DEFAULT_TIP);
}
