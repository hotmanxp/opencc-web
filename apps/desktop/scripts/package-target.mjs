#!/usr/bin/env node
/**
 * Package the desktop application for one target.
 *
 * One invocation owns the whole chain — build the workspace, build the shell,
 * stage the zai runtime, then run electron-builder — so a packaging run can
 * never consume a half-built tree from an earlier command.
 *
 * Usage: node scripts/package-target.mjs [<target>] [--dir] [--check] [--skip-build]
 *   <target>      mac-arm64 | mac-x64 | win-x64; defaults to the host target
 *   --dir         produce an unpacked application directory instead of an installer
 *   --check       validate configuration and inputs without building anything
 *   --skip-build  reuse the existing workspace and shell build output
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ROOT, REPO_ROOT, desktopTargetPaths, detectHostTarget, resolveDesktopTarget } from './target.mjs'
import { prepareRuntime } from './prepare-runtime.mjs'
import { createElectronBuilderConfig } from './electron-builder-config.mjs'
import { run } from './run.mjs'

/**
 * Parse this script's arguments.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{ targetId: string | undefined, dir: boolean, check: boolean, skipBuild: boolean }} parsed options.
 */
function parseArguments(argv) {
  const options = { targetId: undefined, dir: false, check: false, skipBuild: false }
  for (const argument of argv) {
    if (argument === '--dir') options.dir = true
    else if (argument === '--check') options.check = true
    else if (argument === '--skip-build') options.skipBuild = true
    else if (argument.startsWith('--')) throw new Error(`desktop package: unknown option ${argument}`)
    else if (options.targetId === undefined) options.targetId = argument
    else throw new Error(`desktop package: unexpected extra argument ${argument}`)
  }
  return options
}

/**
 * Reject a target this machine cannot build.
 * @param {{ platform: string, id: string }} target - resolved target.
 */
function assertBuildableOnHost(target) {
  if (target.platform === process.platform) return
  throw new Error(
    `desktop package: target ${target.id} needs a ${target.platform} build host, this is ${process.platform}`,
  )
}

/**
 * Run the repository and shell builds that packaging consumes.
 * @param {(message: string) => void} log - progress sink.
 */
async function buildEverything(log) {
  log('desktop: building workspace (zn-agent-core → zai)')
  await run('pnpm', ['run', 'build'], { cwd: REPO_ROOT })
  log('desktop: building the Electron shell')
  await run('pnpm', ['run', 'build'], { cwd: APP_ROOT })
}

/**
 * Invoke electron-builder for one target.
 * @param {{ platform: string, arch: string, id: string }} target - resolved target.
 * @param {boolean} dir - build an unpacked directory instead of an installer.
 * @param {(message: string) => void} log - progress sink.
 */
async function runElectronBuilder(target, dir, log) {
  const cli = join(APP_ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  if (!existsSync(cli)) throw new Error(`desktop package: electron-builder is not installed (${cli})`)

  const args = ['--config', 'electron-builder.config.mjs', target.platform === 'darwin' ? '--mac' : '--win']
  if (!dir) args.push(...(target.platform === 'darwin' ? ['dmg', 'zip'] : ['nsis']))
  args.push(target.arch === 'arm64' ? '--arm64' : '--x64')
  if (dir) args.push('--dir')

  log(`desktop: electron-builder ${args.join(' ')}`)
  await run(process.execPath, [cli, ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, ZAI_DESKTOP_TARGET: target.id },
  })
}

/**
 * List the artifacts a packaging run produced.
 * @param {{ id: string }} target - resolved target.
 * @returns {string[]} artifact file names.
 */
function listArtifacts(target) {
  const directory = desktopTargetPaths(target).artifacts
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => !name.startsWith('.'))
}

/**
 * Report what a packaging run would use without building anything.
 * @param {{ platform: string, arch: string, id: string }} target - resolved target.
 */
function reportConfiguration(target) {
  const paths = desktopTargetPaths(target)
  const config = createElectronBuilderConfig({ ...process.env, ZAI_DESKTOP_TARGET: target.id })
  const builtEntry = join(REPO_ROOT, 'packages', 'zai', 'dist', 'cli', 'index.js')
  console.log('desktop: configuration check')
  console.log(`  target          ${target.id} (${target.platform}/${target.arch})`)
  console.log(`  appId           ${config.appId}`)
  console.log(`  productName     ${config.productName}`)
  console.log(`  version         ${config.extraMetadata.version}`)
  console.log(`  artifacts       ${paths.artifacts}`)
  console.log(`  runtime source  ${builtEntry} ${existsSync(builtEntry) ? '(built)' : '(MISSING — run pnpm run build)'}`)
  console.log(`  mac signed      ${config.mac.identity === null ? 'no (ad-hoc/unsigned)' : `yes (${config.mac.identity})`}`)
  console.log(`  notarize        ${String(config.mac.notarize)}`)
  if (!existsSync(builtEntry)) process.exitCode = 1
}

const options = parseArguments(process.argv.slice(2))
const target = options.targetId === undefined ? detectHostTarget() : resolveDesktopTarget(options.targetId)
assertBuildableOnHost(target)

if (options.check) {
  reportConfiguration(target)
} else {
  if (options.skipBuild) console.log('desktop: reusing existing workspace and shell build output')
  else await buildEverything(console.log)
  await prepareRuntime(target)
  await runElectronBuilder(target, options.dir, console.log)
  const artifacts = listArtifacts(target)
  console.log(`desktop: artifacts in ${desktopTargetPaths(target).artifacts}`)
  for (const name of artifacts) console.log(`  ${name}`)
  if (artifacts.length === 0) throw new Error('desktop package: electron-builder produced no artifacts')
}
