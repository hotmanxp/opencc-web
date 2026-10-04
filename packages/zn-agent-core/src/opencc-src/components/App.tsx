// @ts-nocheck
import type { ReactNode } from 'react';
import { type StatsStore } from '../context/stats.js'
import { type AppState } from '../state/AppState.js'
import type { FpsMetrics } from '../utils/fpsTracker.js';
type Props = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
  children: ReactNode;
};

/**
 * Top-level wrapper for interactive sessions.
 * Provides FPS metrics, stats context, and app state to the component tree.
 */
export function App(t0: Props) {
  return null;
}
