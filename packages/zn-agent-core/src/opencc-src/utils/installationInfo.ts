/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logForDebugging } from './debug.ts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as childProcess from 'node:child_process'
import process from 'node:process'
import { execa } from 'execa'
import { isInBundledMode } from './bundledMode.ts'
import {
  getDetectedLocalInstallDir,
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.ts'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
  getPackageManager,
} from './nativeInstaller/packageManagers.ts'
import { getPlatform } from './platform.ts'

export const isDevelopment = process.env.NODE_ENV === 'development'

export enum PackageManager {
  NPM = 'npm',
  YARN = 'yarn',
  PNPM = 'pnpm',
  PNPX = 'pnpx',
  BUN = 'bun',
  BUNX = 'bunx',
  HOMEBREW = 'homebrew',
  NPX = 'npx',
  BINARY = 'binary',
  UNKNOWN = 'unknown',
}

export interface InstallationInfo {
  packageManager: PackageManager
  isGlobal: boolean
  updateCommand?: string
  updateMessage?: string
}

function getCliBinaryName(): string {
  return MACRO.PACKAGE_URL === '@anthropic-ai/claude-code' ? 'claude' : 'opencc'
}

export function getInstallationInfo(
  projectRoot: string,
  isAutoUpdateEnabled: boolean,
): InstallationInfo {
  const cliPath = process.argv[1]
  if (!cliPath) {
    return { packageManager: PackageManager.UNKNOWN, isGlobal: false }
  }

  try {
    // Check for standalone binary first
    if (process.env.IS_BINARY === 'true' || isInBundledMode()) {
      // Check if installed by package manager (sync detection only)
      if (
        detectHomebrew() ||
        detectWinget() ||
        detectMise() ||
        detectAsdf()
      ) {
        return {
          packageManager: PackageManager.HOMEBREW,
          isGlobal: true,
          updateMessage: 'Installed via package manager. Please update using your package manager.',
        }
      }
      return {
        packageManager: PackageManager.BINARY,
        isGlobal: true,
        updateMessage: 'Running as a standalone binary. Please update by downloading the latest version.',
      }
    }

    // Normalize path separators to forward slashes for consistent matching.
    const realPath = fs.realpathSync(cliPath).replace(/\\/g, '/')
    const normalizedProjectRoot = projectRoot?.replace(/\\/g, '/')

    // Check for local git clone first
    if (
      normalizedProjectRoot &&
      realPath.startsWith(normalizedProjectRoot) &&
      !realPath.includes('/node_modules/')
    ) {
      return {
        packageManager: PackageManager.UNKNOWN,
        isGlobal: false,
        updateMessage: 'Running from a local git clone. Please update with "git pull".',
      }
    }

    // Check for npx/pnpx
    if (realPath.includes('/.npm/_npx') || realPath.includes('/npm/_npx')) {
      return {
        packageManager: PackageManager.NPX,
        isGlobal: false,
        updateMessage: 'Running via npx, update not applicable.',
      }
    }
    if (realPath.includes('/.pnpm/_pnpx') || realPath.includes('/.cache/pnpm/dlx')) {
      return {
        packageManager: PackageManager.PNPX,
        isGlobal: false,
        updateMessage: 'Running via pnpx, update not applicable.',
      }
    }

    // Check for Homebrew
    if (process.platform === 'darwin') {
      try {
        const binaryName = getCliBinaryName()
        const brewPrefix = childProcess
          .execSync(`brew --prefix ${binaryName}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
          .trim()
        const brewRealPath = fs.realpathSync(brewPrefix)

        if (realPath.startsWith(brewRealPath)) {
          return {
            packageManager: PackageManager.HOMEBREW,
            isGlobal: true,
            updateMessage: `Installed via Homebrew. Please update with "brew upgrade ${binaryName}".`,
          }
        }
      } catch {
        // Brew is not installed or package is not installed via brew
      }
    }

    // Check for pnpm
    const pnpmHome = process.env.PPNM_HOME || process.env.PNPM_HOME
    const pnpmPaths = ['.pnpm', '.local/share/pnpm', '.pnpm-global']
    const isPnpmPath = pnpmPaths.some(p => realPath.includes(p)) || realPath.includes('/pnpm/')
    const isUnderPnpmHome = pnpmHome && realPath.startsWith(pnpmHome)

    if (isUnderPnpmHome || isPnpmPath) {
      const updateCommand = `pnpm add -g ${MACRO.PACKAGE_URL}@latest`
      return {
        packageManager: PackageManager.PNPM,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with pnpm. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      }
    }

    // Check for yarn
    if (realPath.includes('/.yarn/global')) {
      const updateCommand = `yarn global add ${MACRO.PACKAGE_URL}@latest`
      return {
        packageManager: PackageManager.YARN,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with yarn. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      }
    }

    // Check for bun
    if (realPath.includes('/.bun/install/cache')) {
      return {
        packageManager: PackageManager.BUNX,
        isGlobal: false,
        updateMessage: 'Running via bunx, update not applicable.',
      }
    }
    if (realPath.includes('/.bun/install/global')) {
      const updateCommand = `bun add -g ${MACRO.PACKAGE_URL}@latest`
      return {
        packageManager: PackageManager.BUN,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with bun. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      }
    }

    // Check for local install
    if (
      normalizedProjectRoot &&
      realPath.startsWith(`${normalizedProjectRoot}/node_modules`)
    ) {
      let pm = PackageManager.NPM
      if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
        pm = PackageManager.YARN
      } else if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
        pm = PackageManager.PNPM
      } else if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
        pm = PackageManager.BUN
      }
      return {
        packageManager: pm,
        isGlobal: false,
        updateMessage: "Locally installed. Please update via your project's package.json.",
      }
    }

    // Check for npm global
    const npmGlobalPaths = [
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
      '/opt/homebrew/lib/node_modules',
      '/.nvm/versions/node/',
    ]

    if (npmGlobalPaths.some(p => realPath.includes(p))) {
      const updateCommand = `npm install -g ${MACRO.PACKAGE_URL}@latest`
      return {
        packageManager: PackageManager.NPM,
        isGlobal: true,
        updateCommand,
        updateMessage: isAutoUpdateEnabled
          ? 'Installed with npm. Attempting to automatically update now...'
          : `Please run ${updateCommand} to update`,
      }
    }

    // Fallback: assume global npm
    const updateCommand = `npm install -g ${MACRO.PACKAGE_URL}@latest`
    return {
      packageManager: PackageManager.NPM,
      isGlobal: true,
      updateCommand,
      updateMessage: isAutoUpdateEnabled
        ? 'Installed with npm. Attempting to automatically update now...'
        : `Please run ${updateCommand} to update`,
    }
  } catch (error) {
    logForDebugging(String(error))
    return { packageManager: PackageManager.UNKNOWN, isGlobal: false }
  }
}
