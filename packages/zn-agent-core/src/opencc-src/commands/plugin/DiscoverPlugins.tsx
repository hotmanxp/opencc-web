// @ts-nocheck
import {  } from '../../constants/product.js'
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- useInput needed for raw search mode text input
import type { LoadedPlugin } from '../../types/plugin.js';
import type { ViewState as ParentViewState } from './types.js';
type Props = {
  error: string | null;
  setError: (error: string | null) => void;
  result: string | null;
  setResult: (result: string | null) => void;
  setViewState: (state: ParentViewState) => void;
  onInstallComplete?: () => void | Promise<void>;
  onSearchModeChange?: (isActive: boolean) => void;
  targetPlugin?: string;
};
type ViewState = 'plugin-list' | 'plugin-details' | {
  type: 'plugin-options';
  plugin: LoadedPlugin;
  pluginId: string;
};
export function DiscoverPlugins({
  error,
  setError,
  result: _result,
  setResult,
  setViewState: setParentViewState,
  onInstallComplete,
  onSearchModeChange,
  targetPlugin
}: Props): React.ReactNode | null {
  // View state
  return null;
}
function DiscoverPluginsKeyHint(t0) {
  return null;
}

/**
 * Context-aware empty state message for the Discover screen
 */
function EmptyStateMessage(t0) {
  return null;
}
