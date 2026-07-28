/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import latestVersion from 'latest-version'
import * as semver from 'semver'
import { logForDebugging } from './debug.js'
import { gt } from './semver.js'

// semver's npm package ships no .d.ts and this project doesn't depend on
// @types/semver, so `import * as semver` resolves to an empty module shape.
// The release-type string union below mirrors semver's `ReleaseType` literal
// type and is the only consumer-facing surface we need.
export type ReleaseType =
  | 'major'
  | 'minor'
  | 'patch'
  | 'premajor'
  | 'preminor'
  | 'prepatch'
  | 'prerelease'

export interface UpdateInfo {
  latest: string
  current: string
  name: string
  type?: ReleaseType
}

export interface UpdateObject {
  message: string
  update: UpdateInfo
  isUpdating?: boolean
}

export interface DistTagsResult {
  latest: string | null
  stable: string | null
}

/**
 * From a nightly and stable version, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: string,
  stable?: string,
): string | null {
  if (!nightly) return stable || null
  if (!stable) return nightly || null

  if (semver.coerce(stable)?.version === semver.coerce(nightly)?.version) {
    return nightly
  }

  return semver.gt(stable, nightly) ? stable : nightly
}

function isNightlyVersion(version: string): boolean {
  return version.includes('nightly')
}

/**
 * Get the latest and stable versions from npm registry.
 * Used by doctor command to display available versions.
 */
export async function getDistTags(
  packageName: string,
): Promise<DistTagsResult> {
  try {
    const [latest, stable] = await Promise.all([
      latestVersion(packageName).catch(() => null),
      latestVersion(packageName, { version: 'stable' }).catch(() => null),
    ])

    return { latest, stable }
  } catch (e) {
    logForDebugging('Failed to get dist-tags: ' + e, { level: 'warn' })
    return { latest: null, stable: null }
  }
}

export async function checkForUpdates(
  packageName: string,
  currentVersion: string,
): Promise<UpdateObject | null> {
  try {
    // Skip update check when running from source (development mode)
    if (MACRO.IS_DEVELOPMENT_BUILD === 'true') {
      return null
    }

    if (!packageName || !currentVersion) {
      return null
    }

    const isNightly = isNightlyVersion(currentVersion)

    if (isNightly) {
      const [nightlyUpdate, latestUpdate] = await Promise.all([
        latestVersion(packageName, { version: 'nightly' }).catch(() => undefined),
        latestVersion(packageName).catch(() => undefined),
      ])

      const bestUpdate = getBestAvailableUpdate(nightlyUpdate, latestUpdate)

      if (bestUpdate && gt(bestUpdate, currentVersion)) {
        const message = `OpenCC update available! ${currentVersion} → ${bestUpdate}`
        const type =
          ((semver as any).diff?.(bestUpdate, currentVersion) as
            | ReleaseType
            | null) || undefined
        return {
          message,
          update: {
            latest: bestUpdate,
            current: currentVersion,
            name: packageName,
            type,
          },
        }
      }
    } else {
      const latestUpdate = await latestVersion(packageName).catch(() => null)
      if (!latestUpdate) {
        return null
      }

      if (gt(latestUpdate, currentVersion)) {
        const message = `OpenCC update available! ${currentVersion} → ${latestUpdate}`
        const type =
          ((semver as any).diff?.(latestUpdate, currentVersion) as
            | ReleaseType
            | null) || undefined
        return {
          message,
          update: {
            latest: latestUpdate,
            current: currentVersion,
            name: packageName,
            type,
          },
        }
      }
    }

    return null
  } catch (e) {
    logForDebugging('Failed to check for updates: ' + e, { level: 'warn' })
    return null
  }
}
