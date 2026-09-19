/**
 * Patch canary (2026-09-16, shell-cwd-drift).
 *
 * `normalizeToolInput` (opencc-src/utils/api.ts) used to strip a leading
 * `cd ${getCwd()} && ` from every Bash command, on the assumption that the
 * shell already sits in getCwd(). That is an *invariant* upstream only because
 * `resetCwdIfOutsideProject` pulls the shell back to the project dir after
 * every foreground call — zai stubs that reset to `false` (see
 * test/unit/compat/vendor/bashCwdResetStub.test.ts) so a per-session cwd
 * survives across turns. The shell is spawned with `cwd = pwd()` from the SDK
 * context compat bashCwdWrap opens per Bash call (`CwdStore.get(sid)`,
 * Shell.ts:234/359), while normalizeToolInput runs in the QUERY-scoped SDK
 * context (`cwd = options.defaultCwd`, createOpenccRuntime-impl.ts:825/848).
 *
 * When those two diverge the strip silently deleted a `cd` that was NOT a
 * no-op, so the command ran in whatever directory the shell had drifted to.
 * Observed live: `cd <repo-root> && pnpm release:patch` executed inside a
 * previously-cd'd subdirectory (session cwd had drifted) and failed with
 * `ERR_PNPM ... Command "release:patch" not found`.
 *
 * Why source-text instead of behaviour: importing utils/api.ts under vitest
 * pulls BashTool.tsx, which depends on bun:bundle globals and dies with
 * "getMaxTimeoutMs is not a function" — the same reason
 * test/unit/constants/prompts.upstream252.test.ts asserts on source text.
 * A future re-vendor that restores upstream's strip fails case 1/2.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const API_TS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'src',
  'opencc-src',
  'utils',
  'api.ts',
)
const src = readFileSync(API_TS, 'utf8')

describe('normalizeToolInput — vendor 不再剥离 Bash 的 `cd … && ` 前缀', () => {
  it('上游的 posix strip 不在源码里', () => {
    expect(src).not.toContain('command.replace(`cd ${cwd} && `, \'\')')
  })

  it('上游的 windows strip 不在源码里', () => {
    expect(src).not.toContain('windowsPathToPosixPath(cwd)')
  })

  it('zai patch 标记与透传实现仍在', () => {
    expect(src).toContain('zai patch (2026-09-16, shell-cwd-drift)')
    // 换行锚定:`command.replace(…)` 那种上游写法不会命中
    expect(src).toContain('let normalizedCommand = command\n')
  })

  it('同分支的其他归一化(\\\\; → \\;)未被误删', () => {
    expect(src).toContain('normalizedCommand.replace(/\\\\\\\\;/g, \'\\\\;\')')
  })
})