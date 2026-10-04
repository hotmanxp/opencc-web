// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { shouldUseNativeAutoUpdater } from '../utils/autoUpdaterRouting.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js';
import { hasNativeDistribution } from '../utils/nativeDistribution.js';
import { AutoUpdater } from './AutoUpdater.js';
import { NativeAutoUpdater } from './NativeAutoUpdater.js';
import { PackageManagerAutoUpdater } from './PackageManagerAutoUpdater.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function AutoUpdaterWrapper(t0) {
  return null;
}
