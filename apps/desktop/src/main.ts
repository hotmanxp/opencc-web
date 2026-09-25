/**
 * Electron shell for zai.
 *
 * The shell owns three things: the Chromium window, the lifecycle of a `zai
 * start` child process, and the handoff between them. It never imports zai —
 * the child is the built CLI served over loopback HTTP, so the window loads a
 * plain `http://127.0.0.1:<port>` origin with no custom protocol or preload.
 */
import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from 'electron'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { resolveDesktopPaths, resolveWorkspace, type DesktopPaths, type HostPaths } from './paths'
import { ZaiProcess, ZaiStartupError } from './zai-process'

/** Window title and the name shown in the About panel and menus. */
const PRODUCT_NAME = '知鸟AI 平台'

/** Process name used for paths and the macOS application menu. */
const APP_NAME = 'zai'

const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 820
const WINDOW_MIN_WIDTH = 520
const WINDOW_MIN_HEIGHT = 600

function hostPaths(): HostPaths {
  return {
    development: !app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    appDataPath: app.getPath('appData'),
  }
}

/**
 * Resolve and install the process-wide paths.
 *
 * Runs before `ready` because `userData` has to be chosen before the first
 * window: Chromium state (cache, cookies, localStorage) lives there, while zai
 * product data stays in `~/.zai` and is owned by the child process.
 * @returns the resolved desktop paths.
 */
function configurePaths(): DesktopPaths {
  try {
    const resolved = resolveDesktopPaths(hostPaths())
    mkdirSync(resolved.userData, { recursive: true })
    app.setPath('userData', resolved.userData)
    app.setName(APP_NAME)
    return resolved
  } catch (error: unknown) {
    // No window exists yet, so a dialog would have nowhere to attach; the exit
    // code plus this message is the only signal available.
    console.error('desktop: cannot prepare the application profile directory', error)
    process.exit(1)
  }
}

const paths: DesktopPaths = configurePaths()

let mainWindow: BrowserWindow | undefined
let zai: ZaiProcess | undefined
let quitting = false

/**
 * Bring the existing window forward.
 *
 * A launch that has not created its window yet is ignored: the window still
 * appears on its own once the server is ready.
 */
function focusPrimaryWindow(): void {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * Build the application window.
 * @returns the created window, hidden until its content is ready.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: '#f9fafb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The renderer is the unmodified zai web application; no embedder or
      // guest content is allowed, so <webview> stays off.
      webviewTag: false,
      devTools: true,
    },
  })

  // Links that ask for a new window belong to the system browser: the shell has
  // no tab strip and must not open a second, unmanaged window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (new URL(url).origin === new URL(current).origin) return
    event.preventDefault()
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
  })
  window.on('closed', () => { mainWindow = undefined })
  mainWindow = window
  return window
}

/** Install a role-based menu so Electron supplies OS-localized labels. */
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Show a native failure dialog and exit.
 * @param error - the startup failure.
 */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostics = error instanceof ZaiStartupError ? error.diagnostics : ''
  console.error(error)
  // Teardown can interrupt a pending start; that failure is expected and must
  // not raise an error box on the way out.
  if (quitting) return
  if (!app.isReady()) {
    process.exitCode = 1
    return
  }
  dialog.showErrorBox(`${PRODUCT_NAME} 启动失败`, diagnostics === '' ? message : `${message}\n\n${diagnostics}`)
  quitting = true
  if (zai === undefined) {
    app.exit(1)
    return
  }
  void zai.stop().finally(() => { app.exit(1) })
}

/**
 * Ensure `<userData>/bin/node` symlinks to this Electron binary.
 *
 * The desktop shell spawns the zai server under `ELECTRON_RUN_AS_NODE=1`, so
 * the server runs on the bundled Node 24. Anything that then runs `node`
 * from a shell (the in-app PTY, the agent's Bash tool) resolves via PATH and
 * would land on the system Node 22 unless that directory is fronted.
 *
 * Returning the shim's directory lets main() prepend it to PATH in the
 * server's env; nothing outside the desktop shell is affected.
 * @param userData - Chromium user-data directory for this shell.
 * @param execPath - Electron binary path (also the bundled Node binary).
 * @returns the directory to prepend to PATH, or empty string on failure.
 */
function ensureNodeShim(userData: string, execPath: string): string {
  const binDir = join(userData, 'bin')
  const linkPath = join(binDir, 'node')
  try {
    if (readlinkSync(linkPath) === execPath) return binDir
    unlinkSync(linkPath)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn('desktop: cannot read existing node shim', error)
      return ''
    }
  }
  try {
    mkdirSync(binDir, { recursive: true })
    symlinkSync(execPath, linkPath)
  } catch (error: unknown) {
    console.warn('desktop: cannot create node shim', error)
    return ''
  }
  return binDir
}

/**
 * Write the zsh init file that the wrapper hands to zsh via ZDOTDIR.
 *
 * The wrapper alone (PATH prepend + `exec /bin/zsh`) is not enough: an
 * interactive shell sources `~/.zshrc`, and `nvm.sh` or similar tools loaded
 * there re-prepend their own directory, burying our shim. Redirecting zsh to
 * our init file lets the init source the user's rc first, then prepend the
 * shim after — so the shim always wins.
 */
function ensureZshInit(userData: string, binDir: string): string {
  const dir = join(userData, 'zsh-init')
  const file = join(dir, '.zshrc')
  const body = [
    '# Generated by the desktop shell. Sources the user rc files first, then',
    '# prepends the bundled-Node shim so interactive shells see Electron Node 24',
    '# instead of whatever toolchain manager (nvm/pyenv/asdf/...) the user loads.',
    '[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"',
    '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
    `export PATH="${binDir}:$PATH"`,
    '',
  ].join('\n')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error: unknown) {
    console.warn('desktop: cannot mkdir zsh-init', error)
    return ''
  }
  try {
    if (readFileSync(file, 'utf8') === body) return dir
  } catch {
    // file does not exist yet; write it
  }
  try {
    writeFileSync(file, body)
  } catch (error: unknown) {
    console.warn('desktop: cannot write zsh-init', error)
    return ''
  }
  return dir
}

/** Write the zsh/bash wrappers; idempotent and content-stable. */
function ensureShellWrappers(userData: string, binDir: string): { zsh: string; bash: string } {
  const zshInitDir = ensureZshInit(userData, binDir)
  const zsh = join(binDir, 'zsh')
  const bash = join(binDir, 'bash')
  writeShellWrapper(zsh, '/bin/zsh', zshInitDir === '' ? [] : [`export ZDOTDIR="${zshInitDir}"`])
  writeShellWrapper(bash, '/bin/bash', [])
  return { zsh, bash }
}

function writeShellWrapper(target: string, realShell: string, extraExports: readonly string[]): void {
  const lines = [
    '#!/bin/sh',
    `export PATH="${binDirOf(target)}:$PATH"`,
    ...extraExports,
    `exec ${realShell} "$@"`,
    '',
  ]
  const body = lines.join('\n')
  try {
    if (lstatSync(target).isSymbolicLink()) return  // the `node` shim already lives here
    if (readFileSync(target, 'utf8') === body) return
    unlinkSync(target)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('desktop: cannot read shell wrapper', error)
      return
    }
  }
  writeFileSync(target, body)
  chmodSync(target, 0o755)
}

function binDirOf(fileInBin: string): string {
  return fileInBin.replace(/\/[^/]+$/u, '')
}

/**
 * Pick the wrapper path for the user's existing shell, if it is zsh or bash.
 * Fish/Custom shells are left untouched — their wrappers are not implemented.
 * @param userShell - the value of $SHELL the desktop shell inherited.
 * @param wrappers - paths to the freshly written zsh/bash wrappers.
 * @returns the wrapper path to set $SHELL to, or undefined to leave $SHELL alone.
 */
function wrapperForShell(userShell: string | undefined, wrappers: { zsh: string; bash: string }): string | undefined {
  if (userShell === undefined) return undefined
  if (userShell.endsWith('/zsh')) return wrappers.zsh
  if (userShell.endsWith('/bash')) return wrappers.bash
  return undefined
}

/**
 * Stop the child, then exit.
 * @returns a promise that settles once teardown finished.
 */
async function shutdown(): Promise<void> {
  const child = zai
  zai = undefined
  if (child === undefined) return
  try {
    await child.stop()
  } catch (error: unknown) {
    console.error(error)
  }
}

async function main(): Promise<void> {
  if (!existsSync(paths.zaiEntry)) {
    throw new ZaiStartupError(`zai entry not found at ${paths.zaiEntry} — run \`pnpm run build\` first`)
  }

  installMenu()
  const window = createWindow()
  await window.loadFile(join(app.getAppPath(), 'renderer', 'loading.html'))
  window.show()

  // Front PATH with a `node` shim (and zsh/bash wrappers) that point at this
  // Electron binary, so the zai server's subprocesses (PTY shell, agent's
  // Bash tool) see the bundled Node 24 instead of the system Node 22. The
  // wrappers prepend the shim dir AFTER user rc files have run — interactive
  // shells (`zsh -i`, `bash -i`) source `~/.zshrc`/`~/.bashrc` and any
  // toolchain manager (nvm, pyenv, ...) loaded there resets PATH, so simply
  // prepending in the child env is not enough.
  const shimDir = ensureNodeShim(paths.userData, process.execPath)
  const wrappers = shimDir === '' ? { zsh: '', bash: '' } : ensureShellWrappers(paths.userData, shimDir)
  const pathEnv = shimDir === '' ? undefined : `${shimDir}${delimiter}${process.env.PATH ?? ''}`
  const shellOverride = wrapperForShell(process.env.SHELL, wrappers)

  const env: Record<string, string> = {}
  if (pathEnv !== undefined) env.PATH = pathEnv
  if (shellOverride !== undefined) env.SHELL = shellOverride

  const child = new ZaiProcess({
    entry: paths.zaiEntry,
    node: process.execPath,
    cwd: resolveWorkspace(),
    env: Object.keys(env).length === 0 ? undefined : env,
    onOutput: (line) => { console.info(`[zai] ${line}`) },
  })
  zai = child

  const ready = await child.start()
  console.info(`[desktop] zai ready at ${ready.url}`)
  await window.loadURL(ready.url)
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  // A second launch hands focus to the running shell and exits.
  app.quit()
} else {
  app.on('second-instance', () => { focusPrimaryWindow() })
  // Closing the window stops the server on every platform: the window is the
  // only way to reach this application, so an invisible server would be
  // unreachable state rather than a background convenience.
  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void shutdown().finally(() => { app.exit(0) })
  })
  app.whenReady()
    .then(main)
    .catch((error: unknown) => { fail(error) })
}
