/** Build-target vocabulary and paths shared by every packaging script. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** Repository root, two levels above `apps/desktop`. */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** This package's directory. */
export const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Build output root; every target owns a subdirectory beneath it. */
export const BUILD_ROOT = join(APP_ROOT, '.desktop-build')

/**
 * @typedef {'mac-arm64' | 'mac-x64' | 'win-x64'} DesktopTargetId
 * @typedef {{ id: DesktopTargetId, platform: 'darwin' | 'win32', arch: 'arm64' | 'x64' }} DesktopTarget
 */

/** @type {Record<DesktopTargetId, DesktopTarget>} */
export const DESKTOP_TARGETS = {
  'mac-arm64': { id: 'mac-arm64', platform: 'darwin', arch: 'arm64' },
  'mac-x64': { id: 'mac-x64', platform: 'darwin', arch: 'x64' },
  'win-x64': { id: 'win-x64', platform: 'win32', arch: 'x64' },
}

/**
 * Resolve a target id.
 * @param {string | undefined} id - target id; must be one of {@link DESKTOP_TARGETS}.
 * @returns {DesktopTarget} the resolved target.
 */
export function resolveDesktopTarget(id) {
  if (id === undefined || id === '') {
    throw new Error(`desktop: ZAI_DESKTOP_TARGET is required (one of ${Object.keys(DESKTOP_TARGETS).join(', ')})`)
  }
  const target = DESKTOP_TARGETS[id]
  if (target === undefined) {
    throw new Error(`desktop: unknown target '${id}' (one of ${Object.keys(DESKTOP_TARGETS).join(', ')})`)
  }
  return target
}

/**
 * Target matching the machine running this command.
 * @returns {DesktopTarget} the host target.
 */
export function detectHostTarget() {
  if (process.platform === 'darwin') {
    return process.arch === 'x64' ? DESKTOP_TARGETS['mac-x64'] : DESKTOP_TARGETS['mac-arm64']
  }
  if (process.platform === 'win32') return DESKTOP_TARGETS['win-x64']
  throw new Error(`desktop: ${process.platform} is not a supported packaging host`)
}

/**
 * Every path one target owns exclusively.
 * @param {DesktopTarget} target - resolved target.
 * @returns {{ root: string, runtime: string, artifacts: string }} target directories.
 */
export function desktopTargetPaths(target) {
  const root = join(BUILD_ROOT, 'targets', target.id)
  return {
    root,
    // Deployed zai package copied into `Contents/Resources/zai-runtime`.
    runtime: join(root, 'zai-runtime'),
    artifacts: join(root, 'artifacts'),
  }
}
