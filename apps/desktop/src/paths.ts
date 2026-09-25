/**
 * Path derivation for the desktop shell.
 *
 * Kept free of `electron` imports so the packaging scripts (which run under
 * plain Node / tsx) can share it with the main process.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Inputs the Electron main process knows that scripts must supply explicitly. */
export interface HostPaths {
  /** True for an unpackaged launch (`!app.isPackaged`). */
  readonly development: boolean
  /** `app.getAppPath()` — the packaged `app.asar` or the `apps/desktop` directory. */
  readonly appPath: string
  /** `process.resourcesPath` — unused in development. */
  readonly resourcesPath: string
  /** `app.getPath('appData')` — per-platform application-data root. */
  readonly appDataPath: string
}

/** Resolved locations of the zai runtime this shell drives. */
export interface DesktopPaths {
  readonly development: boolean
  /** Directory holding `dist/cli/index.js` and the production `node_modules`. */
  readonly zaiRoot: string
  /** Entry point passed to the RunAsNode child. */
  readonly zaiEntry: string
  /** Chromium profile directory; separate from `~/.zai` product data. */
  readonly userData: string
}

function fromEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Locate the built zai package.
 *
 * Development resolves the sibling `packages/zai` of this checkout so the
 * launcher runs whatever the workspace just built. A packaged application
 * resolves the runtime tree copied into `Contents/Resources/zai-runtime`.
 * `ZAI_DESKTOP_ZAI_DIR` overrides both for debugging.
 * @param host - Electron-provided path inputs.
 * @returns absolute path to the zai package root.
 */
export function resolveZaiRoot(host: HostPaths): string {
  const override = fromEnv('ZAI_DESKTOP_ZAI_DIR')
  if (override !== undefined) return resolve(override)
  return host.development
    ? resolve(host.appPath, '..', '..', 'packages', 'zai')
    : join(host.resourcesPath, 'zai-runtime')
}

/**
 * Resolve every path the shell needs.
 * @param host - Electron-provided path inputs.
 * @returns the resolved desktop paths.
 */
export function resolveDesktopPaths(host: HostPaths): DesktopPaths {
  const zaiRoot = resolveZaiRoot(host)
  return {
    development: host.development,
    zaiRoot,
    zaiEntry: join(zaiRoot, 'dist', 'cli', 'index.js'),
    userData: resolveUserData(host),
  }
}

/**
 * Chromium profile directory for this shell.
 *
 * Deliberately not `~/.zai`: that directory holds zai product data (sessions,
 * settings, plugin cache) owned by the runtime, while this one holds only
 * browser state (cache, cookies, localStorage). Development keeps it inside
 * the checkout so a dev launch never writes to the installed application's
 * profile.
 * @param host - Electron-provided path inputs.
 * @returns absolute path to the Chromium profile directory.
 */
export function resolveUserData(host: HostPaths): string {
  const override = fromEnv('ZAI_DESKTOP_USER_DATA_DIR')
  if (override !== undefined) return resolve(override)
  return host.development
    ? join(host.appPath, '.desktop-build', 'user-data')
    : join(host.appDataPath, 'zai-desktop')
}

/**
 * Working directory the zai server treats as the project root.
 *
 * zai records per-project data under `~/.zai/projects/<slug of cwd>`, so this
 * choice decides which project the desktop window opens. `ZAI_DESKTOP_WORKSPACE`
 * overrides it; the default is the user's home directory.
 * @returns absolute path to the server working directory.
 */
export function resolveWorkspace(): string {
  return resolve(fromEnv('ZAI_DESKTOP_WORKSPACE') ?? homedir())
}
