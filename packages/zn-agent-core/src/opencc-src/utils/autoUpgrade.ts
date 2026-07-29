/**
 * Auto-upgrade module for OpenCC
 * Based on nova-cli's auto-upgrade implementation
 */

export { updateEventEmitter, UPDATE_EVENTS } from './updateEventEmitter.ts'
export { checkForUpdates, getDistTags, type UpdateObject, type UpdateInfo, type DistTagsResult } from './updateCheck.ts'
export { handleAutoUpdate, isUpdateInProgress, waitForUpdateCompletion } from './handleAutoUpdate.ts'
export { getInstallationInfo, type InstallationInfo, type PackageManager } from './installationInfo.ts'
