import React, { useEffect, useRef, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { StatusIcon } from '../../components/design-system/StatusIcon.js'
import { Box, render, Text } from '../../ink.js'
import {
  getLatestVersion,
  installGlobalPackage,
} from '../../utils/autoUpdater.js'
import {
  getGlobalConfig,
  type InstallMethod,
  type ReleaseChannel,
} from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { detectGlobalPackageManager } from '../../utils/globalPackageManager.js'
import { installOrUpdateClaudePackage } from '../../utils/localInstaller.js'
import { hasNativeDistribution } from '../../utils/nativeDistribution.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from '../../utils/nativeInstaller/index.js'
import type { PackageManager } from '../../utils/nativeInstaller/packageManagers.js'
import { getPackageManagerUpdateGuidance } from '../../utils/packageManagerUpdateGuidance.js'
import { shouldRemoveInstalledSymlinkForNpmUpdate } from '../../utils/autoUpdaterRouting.js'
import { resolveUpdateStrategy } from '../../utils/updateStrategy.js'

const PACKAGE_URL = MACRO.PACKAGE_URL
const CURRENT_VERSION = MACRO.DISPLAY_VERSION

interface UpdateProps {
  onDone: (
    result: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  force: boolean
  target: string
}

type UpdateState =
  | { type: 'checking' }
  | { type: 'blocked'; reason: 'third-party-build' | 'development' }
  | { type: 'package-manager'; manager: PackageManager }
  | { type: 'no-package-manager' }
  | { type: 'up-to-date'; version: string }
  | { type: 'updating'; version: string; via: string }
  | { type: 'success'; version: string; via: string }
  | { type: 'error'; message: string }

export function PackageManagerUpdateGuidance({
  manager,
}: {
  manager: PackageManager
}): React.ReactNode | null {
  return null;
}

export async function removeStaleNativeLauncherForNpmUpdate(deps: {
  getConfig?: () => { installMethod?: InstallMethod }
  hasNativeDistribution?: () => boolean
  removeInstalledSymlink?: () => Promise<void>
} = {}): Promise<boolean> {
  const config = (deps.getConfig ?? getGlobalConfig)()
  if (
    shouldRemoveInstalledSymlinkForNpmUpdate(
      config.installMethod,
      (deps.hasNativeDistribution ?? hasNativeDistribution)(),
    )
  ) {
    await (deps.removeInstalledSymlink ?? removeInstalledSymlink)()
    return true
  }
  return false
}

function Update({ onDone, force, target }: UpdateProps): React.ReactNode | null {
  return null;
}

// The user-visible system message + dwell time for each terminal state.
function terminalDoneMessage(state: UpdateState): {
  message: string
  delay: number
} {
  switch (state.type) {
    case 'success':
      return { message: 'Z.Ai updated successfully', delay: 3000 }
    case 'up-to-date':
      return { message: 'Z.Ai is already up to date', delay: 1500 }
    case 'blocked':
      return { message: 'Auto-update is unavailable for this build', delay: 3000 }
    case 'package-manager':
      return {
        message: 'Z.Ai is managed by a package manager',
        delay: 3000,
      }
    case 'no-package-manager':
      return { message: 'No supported package manager found', delay: 3000 }
    case 'error':
      return { message: 'Z.Ai update failed', delay: 4000 }
    default:
      return { message: '', delay: 0 }
  }
}

export async function call(
  onDone: (result: string, options?: { display?: CommandResultDisplay }) => void,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const force = tokens.includes('--force')
  const nonFlag = tokens.filter(token => !token.startsWith('--'))
  const target = nonFlag[0] || 'latest'

  const { unmount } = await render(
    <Update
      onDone={(result, options) => {
        unmount()
        onDone(result, options)
      }}
      force={force}
      target={target}
    />,
  )
  return null
}
