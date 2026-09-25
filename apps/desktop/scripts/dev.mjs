#!/usr/bin/env node
/**
 * Build and launch the unpackaged Electron shell against this checkout.
 *
 * Usage: node scripts/dev.mjs [--skip-build]
 *
 * Development always runs the workspace build output (`packages/zai/dist`),
 * never a deployed runtime tree, and keeps its Chromium profile inside the
 * checkout so a dev launch cannot disturb an installed application.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { APP_ROOT, BUILD_ROOT, REPO_ROOT } from './target.mjs'
import { run } from './run.mjs'

const require = createRequire(import.meta.url)

if (!process.argv.includes('--skip-build')) {
  console.log('desktop development: building workspace (zn-agent-core → zai)')
  await run('pnpm', ['run', 'build'], { cwd: REPO_ROOT })
  console.log('desktop development: building the Electron shell')
  await run('pnpm', ['run', 'build'], { cwd: APP_ROOT })
}

const shellEntry = join(APP_ROOT, 'lib', 'main.js')
const zaiEntry = join(REPO_ROOT, 'packages', 'zai', 'dist', 'cli', 'index.js')
for (const [path, hint] of [[shellEntry, 'build the shell'], [zaiEntry, 'build the workspace']]) {
  if (!existsSync(path)) {
    console.error(`desktop development: ${path} is missing — run without --skip-build to ${hint}`)
    process.exit(1)
  }
}

const electron = /** @type {string} */ (require('electron'))
const userData = join(BUILD_ROOT, 'user-data')
console.log(`desktop development: zai=${join(REPO_ROOT, 'packages', 'zai')}`)
console.log(`desktop development: userData=${userData}`)

const child = spawn(electron, [APP_ROOT], {
  cwd: APP_ROOT,
  env: {
    ...process.env,
    ZAI_DESKTOP_ZAI_DIR: join(REPO_ROOT, 'packages', 'zai'),
    ZAI_DESKTOP_USER_DATA_DIR: userData,
    ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? '1',
  },
  stdio: 'inherit',
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === null ? 0 : 1)
})
