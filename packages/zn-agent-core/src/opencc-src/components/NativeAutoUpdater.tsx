import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from 'src/utils/log.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getMaxVersion, getMaxVersionMessage } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { installLatest } from '../utils/nativeInstaller/index.js';
import { gt } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';
import { isAntEmployee } from '../utils/buildConfig.js';

/**
 * Categorize error messages for analytics
 */
function getErrorType(errorMessage: string): string {
  if (errorMessage.includes('timeout')) {
    return 'timeout';
  }
  if (errorMessage.includes('Checksum mismatch')) {
    return 'checksum_mismatch';
  }
  if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
    return 'not_found';
  }
  if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
    return 'permission_denied';
  }
  if (errorMessage.includes('ENOSPC')) {
    return 'disk_full';
  }
  if (errorMessage.includes('npm')) {
    return 'npm_error';
  }
  if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return 'network_error';
  }
  return 'unknown';
}
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function NativeAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode | null {
  return null;
}
