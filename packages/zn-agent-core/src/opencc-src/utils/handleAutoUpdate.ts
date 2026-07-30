/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { UpdateObject } from './updateCheck.js'
import type { SettingsJson } from './settings/types.js'
import { getInstallationInfo, PackageManager } from './installationInfo.js'
import { updateEventEmitter, UPDATE_EVENTS } from './updateEventEmitter.js'
import { logForDebugging } from './debug.js'
import { isInBundledMode } from './bundledMode.js'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
} from './nativeInstaller/packageManagers.js'

let _updateInProgress = false

/** @internal */
export function _setUpdateStateForTesting(value: boolean) {
  _updateInProgress = value
}

export function isUpdateInProgress() {
  return _updateInProgress
}

/**
 * Returns a promise that resolves when the update process completes or times out.
 */
export async function waitForUpdateCompletion(
  timeoutMs = 30000,
): Promise<void> {
  if (!_updateInProgress) {
    return
  }

  logForDebugging(
    '\nOpenCC is waiting for a background update to complete before restarting...',
  )

  return new Promise((resolve) => {
    // Re-check the condition inside the promise executor to avoid a race condition.
    // If the update finished between the initial check and now, resolve immediately.
    if (!_updateInProgress) {
      resolve()
      return
    }

    const timer = setTimeout(cleanup, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      updateEventEmitter.off(UPDATE_EVENTS.UPDATE_SUCCESS, cleanup)
      updateEventEmitter.off(UPDATE_EVENTS.UPDATE_FAILED, cleanup)
      resolve()
    }

    updateEventEmitter.once(UPDATE_EVENTS.UPDATE_SUCCESS, cleanup)
    updateEventEmitter.once(UPDATE_EVENTS.UPDATE_FAILED, cleanup)
  })
}

function isNightlyVersion(version: string): boolean {
  return version.includes('nightly')
}

export function handleAutoUpdate(
  info: UpdateObject | null,
  settings: SettingsJson,
  projectRoot: string,
  _isSandboxEnabled: boolean,
): ChildProcess | undefined {
  if (!info) {
    return undefined
  }

  const installationInfo = getInstallationInfo(
    projectRoot,
    // @ts-expect-error - enableAutoUpdate not in SettingsJson schema
    settings.merged?.general?.enableAutoUpdate,
  )

  if (
    [PackageManager.NPX, PackageManager.PNPX, PackageManager.BUNX, PackageManager.BINARY].includes(
      installationInfo.packageManager,
    )
  ) {
    return undefined
  }

  // Check if running from development build
  if (MACRO.IS_DEVELOPMENT_BUILD === 'true') {
    return undefined
  }

  // Check if running from package manager (sync detection only)
  if (
    detectHomebrew() ||
    detectWinget() ||
    detectMise() ||
    detectAsdf()
  ) {
    return undefined
  }

  let combinedMessage = info.message
  if (installationInfo.updateMessage) {
    combinedMessage += `\n${installationInfo.updateMessage}`
  }

  if (!installationInfo.updateCommand) {
    updateEventEmitter.emit(UPDATE_EVENTS.UPDATE_RECEIVED, {
      ...info,
      message: combinedMessage,
      isUpdating: false,
    })
    return undefined
  }

  updateEventEmitter.emit(UPDATE_EVENTS.UPDATE_RECEIVED, {
    ...info,
    message: combinedMessage,
    isUpdating: true,
  })

  if (_updateInProgress) {
    return undefined
  }

  const currentVersion = info.update.current
  if (!currentVersion) {
    logForDebugging(
      'Update check: current version is missing. Skipping automatic update for safety.',
      { level: 'warn' },
    )
    return undefined
  }

  const isNightly = isNightlyVersion(info.update.latest)

  const updateCommand = installationInfo.updateCommand.replace(
    '@latest',
    isNightly ? '@nightly' : `@${info.update.latest}`,
  )

  const updateProcess = spawn(updateCommand, {
    stdio: 'ignore',
    shell: true,
    detached: true,
  })

  _updateInProgress = true

  // Un-reference the child process to allow the parent to exit independently.
  updateProcess.unref()

  updateProcess.on('close', (code) => {
    _updateInProgress = false
    if (code === 0) {
      updateEventEmitter.emit(UPDATE_EVENTS.UPDATE_SUCCESS, {
        message:
          'Update successful! The new version will be used on your next run.',
      })
    } else {
      updateEventEmitter.emit(UPDATE_EVENTS.UPDATE_FAILED, {
        message: `Automatic update failed. Please try updating manually:\n\n${updateCommand}`,
      })
    }
  })

  updateProcess.on('error', (err) => {
    _updateInProgress = false
    updateEventEmitter.emit(UPDATE_EVENTS.UPDATE_FAILED, {
      message: `Automatic update failed. Please try updating manually. (error: ${err.message})\n\n${updateCommand}`,
    })
  })

  return updateProcess
}
