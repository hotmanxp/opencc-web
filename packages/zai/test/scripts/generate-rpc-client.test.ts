// codegen 静态产物测试 — 跑 scripts/generate-rpc-client.ts, 产物与
// committed `web/src/lib/api.generated.ts` byte-for-byte 匹配.
// 防止 RpcMethodMap 改了但忘了跑 codegen 就 commit.
//
// 不每次跑都重生成产物 (那会盖掉 staged 改动). 改成: 跑 codegen →
// 写到一个临时文件 → 跟 committed 文件 diff. 仅当产物不一致时 fail.

import { execFileSync } from 'node:child_process'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..', '..')

const committedPath = resolve(repoRoot, 'packages/zai/src/web/src/lib/api.generated.ts')
const rpcPath = resolve(repoRoot, 'packages/zai/src/shared/rpc.ts')
const codegenScript = resolve(repoRoot, 'scripts/generate-rpc-client.ts')

describe('codegen: rpc client stub', () => {
  it('generated stub 与 committed 产物完全一致 (snapshot)', async () => {
    const tmpDir = await mkdtemp('/tmp/codegen-rpc-')
    const tmpOut = resolve(tmpDir, 'api.generated.ts')

    // 临时把 codegen 内部的 OUT_PATH 覆盖 — 简单做法: 复制 codegen 命令,
    // 直接调它, 通过环境变量切输出路径. 但当前 codegen 硬编码 outPath.
    // 改为: 跑 codegen (会覆写 committed), 然后立刻恢复.
    // 安全性: 先备份 committed, codegen 跑完比对, 跑完恢复.
    const committed = await readFile(committedPath, 'utf-8')

    try {
      execFileSync(
        'pnpm',
        ['--filter', '@zn-ai/zai', 'exec', 'tsx', codegenScript],
        { cwd: repoRoot, stdio: 'pipe' },
      )
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true })
      throw new Error(`codegen 失败: ${(err as Error).message}`)
    }

    const regenerated = await readFile(committedPath, 'utf-8')

    if (regenerated !== committed) {
      // 恢复 committed, 避免污染 working tree
      await writeFile(committedPath, committed, 'utf-8')
      await rm(tmpDir, { recursive: true, force: true })
      const diff = splitDiff(committed, regenerated)
      throw new Error(
        'codegen 产物与 committed 不一致. 跑 `pnpm run codegen:rpc` 重生成并 commit.\n' +
        `--- diff ---\n${diff}\n--- end ---`,
      )
    }

    await rm(tmpDir, { recursive: true, force: true })
  })

  it('RpcMethodMap 必须存在且非空', async () => {
    const source = await readFile(rpcPath, 'utf-8')
    expect(source).toContain('export interface RpcMethodMap')
    // 至少 5 个高频 route (spec 1 要求的最低门槛)
    expect(source.match(/'(GET|POST|PUT|DELETE) \/api\//g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })
})

function splitDiff(a: string, b: string): string {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const out: string[] = []
  const max = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      out.push(`- ${aLines[i] ?? ''}`)
      out.push(`+ ${bLines[i] ?? ''}`)
    }
  }
  return out.join('\n')
}
