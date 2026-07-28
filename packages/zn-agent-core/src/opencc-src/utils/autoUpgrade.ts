/**
 * Auto-upgrade module for OpenCC
 * Based on nova-cli's auto-upgrade implementation
 */

export { updateEventEmitter, UPDATE_EVENTS } from './updateEventEmitter.js'
export { checkForUpdates, getDistTags, type UpdateObject, type UpdateInfo, type DistTagsResult } from './updateCheck.js'
export { handleAutoUpdate, isUpdateInProgress, waitForUpdateCompletion } from './handleAutoUpdate.js'
export { getInstallationInfo, type InstallationInfo, type PackageManager } from './installationInfo.js'
