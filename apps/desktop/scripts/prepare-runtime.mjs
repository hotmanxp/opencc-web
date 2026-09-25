/**
 * Stage the zai runtime tree for one target.
 *
 * `pnpm deploy` is what makes the tree self-contained: it packs `@zn-ai/zai`
 * (its `files` field limits the copy to `bin/` and `dist/`) together with its
 * production dependency closure, and materializes the workspace dependency
 * `@zn-ai/zn-agent-core` as a real directory instead of a workspace link. The
 * result is copied verbatim into `Contents/Resources/zai-runtime`.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, desktopTargetPaths } from './target.mjs'
import { run } from './run.mjs'

/** Files that must exist for a deployed tree to be runnable. */
const REQUIRED = [
  ['dist/cli/index.js', 'the zai CLI entry'],
  ['dist/web/index.html', 'the built web frontend'],
  ['node_modules', 'the production dependency tree'],
]

/** `process.platform` / `process.arch` spellings a prebuild directory may use. */
const TARGET_PLATFORMS = ['darwin', 'win32', 'linux']
const TARGET_ARCHES = ['arm64', 'x64', 'ia32']

/**
 * Remove native binaries this target cannot execute.
 *
 * Two vendored packages ship every platform in one tarball, and neither is
 * reachable on another target's machine:
 *
 *   - `node-pty/prebuilds/<platform>-<arch>/` — 23 MB in total, of which the
 *     target's own directory is roughly 140 KB (the Windows ConPTY payloads
 *     account for almost all of it).
 *   - `zn-agent-core/vendor/ripgrep/rg-<platform>-<arch>[.exe]` — 11.6 MB in
 *     total, of which the target's own binary is roughly 3 MB.
 *
 * Each prune is skipped unless the target's own artifact is present, so a
 * layout change degrades to "nothing removed" instead of "the matching binary
 * removed too".
 * @param {string} runtime - deployed runtime directory.
 * @param {{ platform: string, arch: string }} target - resolved desktop target.
 * @param {(message: string) => void} log - progress sink.
 */
function pruneForeignBinaries(runtime, target, log) {
  const variantPattern = new RegExp(`^(${TARGET_PLATFORMS.join('|')})-(${TARGET_ARCHES.join('|')})$`)
  const wanted = `${target.platform}-${target.arch}`

  // node-pty lives in a versioned `.pnpm` entry; find it by prefix so a version
  // bump does not silently disable the prune.
  const pnpm = join(runtime, 'node_modules', '.pnpm')
  for (const entry of readdirSync(pnpm).filter((name) => name.startsWith('node-pty@'))) {
    const prebuilds = join(pnpm, entry, 'node_modules', 'node-pty', 'prebuilds')
    if (!existsSync(join(prebuilds, wanted))) continue
    for (const name of readdirSync(prebuilds)) {
      if (name !== wanted && variantPattern.test(name)) {
        rmSync(join(prebuilds, name), { recursive: true, force: true })
        log(`desktop: pruned node-pty prebuild ${name}`)
      }
    }
  }

  const suffix = target.platform === 'win32' ? '.exe' : ''
  const wantedRg = `rg-${target.platform}-${target.arch}${suffix}`
  const rgPattern = new RegExp(`^rg-(${TARGET_PLATFORMS.join('|')})-(${TARGET_ARCHES.join('|')})(\\.exe)?$`)
  const ripgrep = join(runtime, 'node_modules', '@zn-ai', 'zn-agent-core', 'vendor', 'ripgrep')
  if (!existsSync(join(ripgrep, wantedRg))) return
  for (const name of readdirSync(ripgrep)) {
    if (name !== wantedRg && rgPattern.test(name)) {
      rmSync(join(ripgrep, name), { force: true })
      log(`desktop: pruned ripgrep binary ${name}`)
    }
  }
}

/**
 * Deploy the built zai package for one target.
 * @param {{ id: string }} target - resolved desktop target.
 * @param {(message: string) => void} [log] - progress sink.
 * @returns {Promise<string>} the deployed runtime directory.
 */
export async function prepareRuntime(target, log = console.log) {
  const builtEntry = join(REPO_ROOT, 'packages', 'zai', 'dist', 'cli', 'index.js')
  if (!existsSync(builtEntry)) {
    throw new Error(`desktop: ${builtEntry} is missing — run \`pnpm run build\` before packaging`)
  }

  const paths = desktopTargetPaths(target)
  // A partial tree from an interrupted run must never be reused.
  rmSync(paths.runtime, { recursive: true, force: true })

  log(`desktop: deploying zai runtime to ${paths.runtime}`)
  await run('pnpm', ['--filter', '@zn-ai/zai', 'deploy', paths.runtime, '--prod'], { cwd: REPO_ROOT })

  for (const [relative, description] of REQUIRED) {
    const path = join(paths.runtime, relative)
    if (!existsSync(path)) {
      throw new Error(`desktop: deployed runtime is missing ${description} (${path})`)
    }
  }

  // The workspace copy links `@zn-ai/zn-agent-core`; a link would break once
  // the tree is copied into the application bundle, so reject it here rather
  // than shipping an application that cannot start.
  const core = join(paths.runtime, 'node_modules', '@zn-ai', 'zn-agent-core')
  if (!existsSync(join(core, 'dist', 'opencc-core.mjs'))) {
    throw new Error(`desktop: deployed runtime did not materialize @zn-ai/zn-agent-core (${core})`)
  }

  pruneForeignBinaries(paths.runtime, target, log)

  log(`desktop: runtime ready at ${paths.runtime}`)
  return paths.runtime
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { resolveDesktopTarget } = await import('./target.mjs')
  const target = resolveDesktopTarget(process.env.ZAI_DESKTOP_TARGET)
  await prepareRuntime(target).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
