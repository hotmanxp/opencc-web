import { describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
// 本文件在 packages/zai/test/cli/ 下 → 上溯三级到 packages/zai
const PKG_ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const GUARDS = resolve(PKG_ROOT, 'src/cli/processGuards.ts')

/**
 * R2-a:进程级 unhandledRejection 兜底必须真的保住进程。
 *
 * 跑**真子进程**,因为这层兜底的性质就是「进程会不会死」——同进程里测不出来
 * (测试进程自己死了,suite 直接中断,而不是得到一条断言失败)。
 *
 * 脚本 import 的是**真正发布的那份** processGuards.ts,不是复制品:兜底一旦被
 * 误删,症状是「某个请求的 ENOENT 悄悄干掉整个 server」,离原因隔得很远。
 */
function runChild(body: string): Promise<{ stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'guards-'))
  const file = join(dir, 'child.mts')
  writeFileSync(file, body, 'utf-8')
  // 用 tsx 的 JS 入口而非 node_modules/.bin/tsx —— 后者是 shell wrapper,
  // 不能直接交给 node 执行。
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
  return execFileAsync(
    process.execPath,
    [tsxCli, file],
    { cwd: PKG_ROOT, timeout: 60_000 },
  ).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('installProcessGuards', () => {
  test('有兜底:unhandledRejection 之后进程存活,并记下 [zai-fatal]', async () => {
    const { stdout, stderr } = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(GUARDS)}
      installProcessGuards()
      void Promise.reject(new Error('boom-from-a-request'))
      setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 1500)
    `)
    // 核心断言:进程活着走到了 SURVIVED,而不是被 rejection 带走
    expect(stdout).toContain('SURVIVED')
    // 兜底确实记了日志(console.error 走 stderr)
    expect(stderr).toContain('[zai-fatal] unhandledRejection')
    expect(stderr).toContain('boom-from-a-request')
  })

  test('无兜底:同一段代码会让进程直接死(证明上一条不是恒真)', async () => {
    await expect(runChild(`
      void Promise.reject(new Error('boom-from-a-request'))
      setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 1500)
    `)).rejects.toMatchObject({ code: 1 })
  })

  test('非 Error 的 rejection(字符串/null)也能兜住,不炸', async () => {
    const { stdout, stderr } = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(GUARDS)}
      installProcessGuards()
      void Promise.reject('a bare string reason')
      setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 1500)
    `)
    expect(stdout).toContain('SURVIVED')
    expect(stderr).toContain('[zai-fatal] unhandledRejection')
    // 没有 stack 时也要有兜底文案,而不是打出 undefined
    expect(stderr).toContain('no stack')
  })

  test('多个 rejection 都会被记录,且进程始终存活', async () => {
    const { stdout, stderr } = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(GUARDS)}
      installProcessGuards()
      void Promise.reject(new Error('first'))
      void Promise.reject(new Error('second'))
      setTimeout(() => { console.log('SURVIVED'); process.exit(0) }, 1500)
    `)
    expect(stdout).toContain('SURVIVED')
    expect(stderr).toContain('first')
    expect(stderr).toContain('second')
  })
})
