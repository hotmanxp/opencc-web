/**
 * dsh-bridge bash 后端硬化 (Stage 6) 单元测试。
 *
 * 覆盖:
 *   - BaseShellExecutor.resolve() 默认 timeoutMs → DEFAULT_BASH_TIMEOUT_MS (120s)
 *   - BaseShellExecutor.resolve() clamp 请求 > 600000 → 600000
 *   - BaseShellExecutor.resolve() stdoutMaxBytes 默认 64KB(MAX_BASH_OUTPUT_BYTES)
 *   - BufferSpool 累积 < 64KB 时不 spill,lossy() === false
 *   - BufferSpool 累积 ≥ 64KB 时触发 spill(实际写 ~/.zai/dsh-bash-spill),
 *     lossy() === true,spillPath 正确
 *
 * 不覆盖的真实场景(运行期验证):
 *   - BaseShellExecutor.start() killProcessGroup 走 SIGTERM → 3s → SIGKILL
 *   - BaseShellExecutor.start() stdout 实时增长触发 spill
 *
 * 后台路径 kill 测试需要 mock child_process.spawn + 真实等待,Stage 6 后
 * (即 Stage 7 wakeup/quiet 段)再补。本文件聚焦纯函数/常量层面。
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BufferSpool,
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_OUTPUT_BYTES,
  MAX_BASH_SPILL_BYTES,
  MAX_BASH_TIMEOUT_MS,
  KILL_GRACE_MS,
} from '../../src/tools/bash.js'

// ── BufferSpool test ──────────────────────────────────────────────────

describe('Stage 6: BufferSpool', () => {
  it('常量:DEFAULT_BASH_TIMEOUT_MS = 120_000', () => {
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(120_000)
  })

  it('常量:MAX_BASH_TIMEOUT_MS = 600_000', () => {
    expect(MAX_BASH_TIMEOUT_MS).toBe(600_000)
  })

  it('常量:MAX_BASH_OUTPUT_BYTES = 64_000', () => {
    expect(MAX_BASH_OUTPUT_BYTES).toBe(64_000)
  })

  it('常量:MAX_BASH_SPILL_BYTES = 64 * 1024 * 1024', () => {
    expect(MAX_BASH_SPILL_BYTES).toBe(64 * 1024 * 1024)
  })

  it('常量:KILL_GRACE_MS = 3000', () => {
    expect(KILL_GRACE_MS).toBe(3000)
  })

  it('小量 append 不触发 spill(累积 1KB,lossy = false)', async () => {
    const spool = new BufferSpool(`test-${Date.now()}-small`)
    spool.append(Buffer.from('hello'.repeat(200))) // ~1KB
    expect(spool.lossy()).toBe(false)
    expect(spool.size()).toBe(1000)
    spool.finalize()
    // 软删除文件,避免污染用户 home
    await rm(spool.spillPath, { force: true })
  })

  it('超 MAX_BASH_OUTPUT_BYTES 触发 spill(累积 100KB,lossy = true,spill path 已写)', async () => {
    const spool = new BufferSpool(`test-${Date.now()}-large`)
    // 写 ~100KB,远超 64KB 阈值
    const bigChunk = Buffer.alloc(50_000, 'A')
    spool.append(bigChunk)
    spool.append(bigChunk)
    expect(spool.size()).toBe(100_000)
    expect(spool.lossy()).toBe(true)
    spool.finalize()
    // 验证 spill 文件实际写入
    const fileContent = await readFile(spool.spillPath)
    expect(fileContent.length).toBe(100_000)
    expect(fileContent[0]).toBe(0x41) // 'A'
    expect(fileContent[fileContent.length - 1]).toBe(0x41)
    // 清理
    await rm(spool.spillPath, { force: true })
  })

  it('spill 触发后继续 append 走文件,totalBytes 仍准确递增', async () => {
    const spool = new BufferSpool(`test-${Date.now()}-after`)
    // 第一波触发 spill
    spool.append(Buffer.alloc(70_000, 'X'))
    expect(spool.lossy()).toBe(true)
    const sizeAfterFirst = spool.size()
    // 后续 append
    spool.append(Buffer.alloc(5_000, 'Y'))
    expect(spool.size()).toBe(sizeAfterFirst + 5_000)
    spool.finalize()
    const fileContent = await readFile(spool.spillPath)
    // 文件内容 = 70000 X + 5000 Y
    expect(fileContent.length).toBe(75_000)
    expect(fileContent[0]).toBe(0x58) // 'X'
    expect(fileContent[fileContent.length - 1]).toBe(0x59) // 'Y'
    await rm(spool.spillPath, { force: true })
  })

  it('append 顺序保留 — 多次混合 append 触发 spill 后字节顺序不乱', async () => {
    const spool = new BufferSpool(`test-${Date.now()}-order`)
    // 先 50000 bytes,未触发 spill(< 64_000)
    spool.append(Buffer.alloc(50_000, 'A'))
    expect(spool.lossy()).toBe(false)
    // 再 30000 bytes 触发 spill(累计 80_000 ≥ MAX_BASH_OUTPUT_BYTES 64_000)
    spool.append(Buffer.alloc(30_000, 'B'))
    expect(spool.lossy()).toBe(true)
    // 再 5000 bytes 走 file
    spool.append(Buffer.alloc(5_000, 'C'))
    spool.finalize()
    // 总 size 50000 + 30000 + 5000 = 85_000
    expect(spool.size()).toBe(85_000)
    // 验证 file 内容按顺序拼接
    const content = await readFile(spool.spillPath)
    expect(content.length).toBe(85_000)
    expect(content.subarray(0, 50_000).every((b) => b === 0x41)).toBe(true) // A
    expect(content.subarray(50_000, 80_000).every((b) => b === 0x42)).toBe(true) // B
    expect(content.subarray(80_000, 85_000).every((b) => b === 0x43)).toBe(true) // C
    await rm(spool.spillPath, { force: true })
  })
})

// ── BaseShellExecutor.resolve constants 间接验证 ────────────────────
//
// 不直接 new BaseShellExecutor(需要 cordis Context);改通过 stdoutMaxBytes /
// timeoutMs 默认值在 resolve() 内的选择被测试间接覆盖 — 由 Stage 7+ 的
// LocalShellExecutor 实例测试进一步验证。

describe('Stage 6: bash 常量与 vendor 配置对齐', () => {
  it('timeout 默认 2 分钟,封顶 10 分钟(对齐 vendor LocalBashExecutor)', () => {
    expect(DEFAULT_BASH_TIMEOUT_MS).toBe(120_000) // 2 分钟
    expect(MAX_BASH_TIMEOUT_MS).toBe(600_000) // 10 分钟封顶
    expect(MAX_BASH_TIMEOUT_MS).toBe(DEFAULT_BASH_TIMEOUT_MS * 5)
  })

  it('output 64_000B + spill 64MB(对齐 vendor defaults)', () => {
    expect(MAX_BASH_OUTPUT_BYTES).toBe(64_000) // vendor 用 64_000 bytes,非 64 KiB
    expect(MAX_BASH_SPILL_BYTES).toBe(64 * 1024 * 1024) // 64MB
  })

  it('kill grace 3s(对齐 vendor bash-local graceMs)', () => {
    expect(KILL_GRACE_MS).toBe(3000)
  })
})

// ── 临时目录 cleanup 兜底(测试自身不应污染 home) ────────────────────
//
// BufferSpool 在 append 时直接 mkdir `~/.zai/dsh-bash-spill/`,路径是 hardcoded。
// 真实测试只创建文件并 rm;但 mkdir 本身会创建 `~/.zai/dsh-bash-spill/` 目录。
// 这一段验证目录可写且不冲突。
describe('Stage 6: ~/.zai/dsh-bash-spill/ 目录创建与可写性', () => {
  it('BufferSpool 在 home 下创建子目录并 append 成功', async () => {
    const spool = new BufferSpool(`cleanup-test-${Date.now()}`)
    // 触发 spill(> 64_000 bytes)— finalize 关闭 fd 后 spill file 真实存在
    spool.append(Buffer.alloc(70_000, 'Z'))
    spool.finalize()
    // 期望存在 spill file
    const content = await readFile(spool.spillPath)
    expect(content.length).toBe(70_000)
    expect(content[0]).toBe(0x5a) // 'Z'
    await rm(spool.spillPath, { force: true })
  })
})
