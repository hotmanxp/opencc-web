// @ts-nocheck
import * as React from 'react';
import { type AutoUpdaterResult } from '../utils/autoUpdater.js'
import { type PackageManager } from '../utils/nativeInstaller/packageManagers.js'
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function PackageManagerUpdateAvailableNotice({ manager }: { manager: PackageManager }) {
  return null;
}
export function PackageManagerAutoUpdater(t0) {
  return null;
}
