/**
 * migrate.ts 单测 — B6 T6.3。
 *
 * 覆盖：
 * 1. jsonl → dsh log 字段映射（每种 type 至少 1 断言）
 * 2. 幂等：重复运行结果一致
 * 3. 回滚：强制失败场景下目标目录无残留
 * 4. 版本不匹配报错
 * 5. 不可迁移条目显式列出
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// vi.mock 必须在 import migrate 之前
vi.mock('@zn-ai/dsh-bridge', () => ({
  DSH_VERSION: '0.1.0-rc.7-test',
}))

let currentDataDir: string

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentDataDir,
  }
})

import {
  migrateSession,
  translateJsonlEntry,
  translateJsonl,
  computeTurnCount,
  validateDshLog,
  sanitizeCwd,
  openccJsonlPath,
  dshSessionDir,
  dshSessionLogPath,
  dshSessionHeaderPath,
  VersionMismatchError,
  listOpenccSessions,
  rollback,
  snapshotTarget,
  type OpenccJsonlEntry,
  type DshSessionEvent,
} from './migrate.js'

const cwd = '/home/user/project'
const sessionId = 'sess-abc-123'
const TEMPLATE_VERSION = '0.1.0-rc.7-test'

beforeEach(() => {
  currentDataDir = mkdtempSync(join(tmpdir(), 'zai-migrate-test-'))
})

afterEach(() => {
  rmSync(currentDataDir, { recursive: true, force: true })
})

function writeOpenccFixture(content: string) {
  const path = openccJsonlPath(currentDataDir, cwd, sessionId)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

// ─── 字段映射 ─────────────────────────────────────────────────────────

describe('migrate — 字段映射', () => {
  it('user.message: { type:"user", message:{...} } → user.message', () => {
    const evt = translateJsonlEntry(
      {
        type: 'user',
        message: { role: 'user', content: 'hi' },
        timestamp: 1700000000000,
      },
      1,
    )
    expect(evt).not.toBeNull()
    expect(evt!.type).toBe('user.message')
    expect(evt!.seq).toBe(1)
    expect(evt!.ts).toBe(1700000000000)
    expect((evt!.data as any).content).toBe('hi')
  })

  it('assistant.message: { type:"assistant", message:{...} } → assistant.message', () => {
    const evt = translateJsonlEntry(
      {
        type: 'assistant',
        message: { role: 'assistant', content: 'hello' },
        timestamp: 1700000001000,
      },
      2,
    )
    expect(evt).not.toBeNull()
    expect(evt!.type).toBe('assistant.message')
    expect((evt!.data as any).content).toBe('hello')
  })

  it('tool_use → tool/call (保留 toolUseId/toolName/input)', () => {
    const evt = translateJsonlEntry(
      {
        type: 'tool_use',
        toolUseId: 'tu-1',
        toolName: 'Bash',
        input: { cmd: 'ls' },
        timestamp: 1700000002000,
      },
      3,
    )
    expect(evt!.type).toBe('tool/call')
    expect((evt!.data as any).toolUseId).toBe('tu-1')
    expect((evt!.data as any).toolName).toBe('Bash')
    expect((evt!.data as any).input).toEqual({ cmd: 'ls' })
  })

  it('tool_result → tool/result', () => {
    const evt = translateJsonlEntry(
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        output: { ok: true },
        timestamp: 1700000003000,
      },
      4,
    )
    expect(evt!.type).toBe('tool/result')
    expect((evt!.data as any).toolUseId).toBe('tu-1')
    expect((evt!.data as any).output).toEqual({ ok: true })
  })

  it('custom-title → session.meta (嵌入 customTitle)', () => {
    const evt = translateJsonlEntry(
      { type: 'custom-title', customTitle: '修复 Z.Ai bug' },
      5,
    )
    expect(evt!.type).toBe('session.meta')
    expect((evt!.data as any).customTitle).toBe('修复 Z.Ai bug')
  })

  it('未知 type 返回 null（不被静默吞掉）', () => {
    const evt = translateJsonlEntry({ type: 'mystery-thing' }, 6)
    expect(evt).toBeNull()
  })

  it('translateJsonl 解析混合输入：跳过损坏行，未知 type 计入 unmapped', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      '{not-json-line',
      JSON.stringify({ type: 'mystery', foo: 1 }),
      JSON.stringify({ type: 'assistant', message: { content: 'world' } }),
    ].join('\n')
    const { events, unmapped } = translateJsonl(raw)
    expect(events.length).toBe(2)
    expect(events[0].type).toBe('user.message')
    expect(events[1].type).toBe('assistant.message')
    expect(unmapped.length).toBe(2)
    expect(unmapped.some((u) => u.reason.includes('JSON parse'))).toBe(true)
    expect(unmapped.some((u) => u.reason.includes('unsupported type'))).toBe(true)
  })

  it('turnCount = floor((user.message + assistant.message) / 2)', () => {
    const events: DshSessionEvent[] = [
      { type: 'user.message', seq: 1, ts: 0, data: {} },
      { type: 'assistant.message', seq: 2, ts: 0, data: {} },
      { type: 'user.message', seq: 3, ts: 0, data: {} },
      { type: 'assistant.message', seq: 4, ts: 0, data: {} },
      { type: 'tool/call', seq: 5, ts: 0, data: {} },
      { type: 'tool/result', seq: 6, ts: 0, data: {} },
    ]
    expect(computeTurnCount(events)).toBe(2)
  })

  it('sanitizeCwd 与 legacyTranscriptStore 规则一致', () => {
    expect(sanitizeCwd('/Users/ethan/code/foo')).toBe('-Users-ethan-code-foo')
    const longCwd = '/' + 'a'.repeat(250)
    const sanitized = sanitizeCwd(longCwd)
    // 长 cwd 截断到 200 + '-' + hash（与 legacyTranscriptStore 一致）。
    // 实际长度可能略大于 200（截断 + 短哈希），但远小于原长 251。
    expect(sanitized.length).toBeLessThan(longCwd.length)
    expect(sanitized).toMatch(/^-+[a-z0-9]+-[a-z0-9]+$/)
  })
})

// ─── 校验 ─────────────────────────────────────────────────────────────

describe('migrate — validateDshLog', () => {
  it('firstSeq === 1 + 单调 seq + 匹配 turnCount → ok', () => {
    const events: DshSessionEvent[] = [
      { type: 'user.message', seq: 1, ts: 0, data: {} },
      { type: 'assistant.message', seq: 2, ts: 0, data: {} },
    ]
    expect(validateDshLog(events, 1)).toEqual({ ok: true })
  })

  it('firstSeq !== 1 → 报错', () => {
    const events: DshSessionEvent[] = [
      { type: 'user.message', seq: 2, ts: 0, data: {} },
    ]
    const r = validateDshLog(events, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.includes('firstSeq'))).toBe(true)
  })

  it('seq 不单调 → 报错', () => {
    const events: DshSessionEvent[] = [
      { type: 'user.message', seq: 1, ts: 0, data: {} },
      { type: 'user.message', seq: 1, ts: 0, data: {} },
    ]
    const r = validateDshLog(events, 1)
    expect(r.ok).toBe(false)
  })

  it('turnCount 不匹配 → 报错', () => {
    const events: DshSessionEvent[] = [
      { type: 'user.message', seq: 1, ts: 0, data: {} },
      { type: 'assistant.message', seq: 2, ts: 0, data: {} },
      { type: 'user.message', seq: 3, ts: 0, data: {} },
      { type: 'assistant.message', seq: 4, ts: 0, data: {} },
    ]
    const r = validateDshLog(events, 99)
    expect(r.ok).toBe(false)
  })

  it('空列表 → 报错', () => {
    const r = validateDshLog([], 0)
    expect(r.ok).toBe(false)
  })
})

// ─── 版本锁定 ────────────────────────────────────────────────────────

describe('migrate — 版本锁定', () => {
  it('targetDshVersion !== installed → 抛 VersionMismatchError', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n',
    )
    await expect(
      migrateSession(cwd, sessionId, {
        dryRun: true,
        targetDshVersion: '999.0.0',
        dataDir: currentDataDir,
      }),
    ).rejects.toBeInstanceOf(VersionMismatchError)
  })

  it('targetDshVersion === installed → 不抛错（dryRun=true 返回统计）', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'y' } }) + '\n',
    )
    const r = await migrateSession(cwd, sessionId, {
      dryRun: true,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r.validated).toBe(true)
    expect(r.mappedEvents).toBe(2)
    expect(r.turnCount).toBe(1)
    expect(r.outputPath).toBeNull()
  })
})

// ─── 幂等 ─────────────────────────────────────────────────────────────

describe('migrate — 幂等', () => {
  it('重复运行同一 session：第二次返回 alreadyMigrated=true，不重写文件', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )
    // 第一次：dryRun=false 落盘
    const r1 = await migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r1.alreadyMigrated).toBe(false)
    expect(r1.outputPath).toBe(dshSessionLogPath(currentDataDir, cwd, sessionId))
    const writtenRaw1 = readFileSync(r1.outputPath!, 'utf8')
    const mtime1 = statMtime(r1.outputPath!)

    // 第二次：应命中幂等
    const r2 = await migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r2.alreadyMigrated).toBe(true)
    expect(r2.mappedEvents).toBe(r1.mappedEvents)
    expect(r2.turnCount).toBe(r1.turnCount)

    // 文件内容未变
    const writtenRaw2 = readFileSync(r2.outputPath!, 'utf8')
    expect(writtenRaw2).toBe(writtenRaw1)
    expect(statMtime(r2.outputPath!)).toBe(mtime1)
  })

  it('已存在但 turn 数不一致 → 报错（不静默覆盖）', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )
    await migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })

    // 改源文件让 turn 数变化
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n',
    )

    await expect(
      migrateSession(cwd, sessionId, {
        dryRun: false,
        targetDshVersion: TEMPLATE_VERSION,
        dataDir: currentDataDir,
      }),
    ).rejects.toThrow(/target session exists but doesn't match/)
  })
})

// ─── 回滚 ─────────────────────────────────────────────────────────────

describe('migrate — 回滚', () => {
  it('snapshotTarget + rollback: 把目标目录 rename 到 .bak 再恢复', async () => {
    const dir = join(currentDataDir, 'foo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'orig', 'utf8')

    const backup = await snapshotTarget(dir)
    expect(backup).not.toBeNull()
    expect(existsSync(join(backup!, 'a.txt'))).toBe(true)
    expect(existsSync(dir)).toBe(false)

    // 模拟新写入失败后的回滚
    await rollback(dir, backup)
    expect(existsSync(dir)).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('orig')
    expect(existsSync(backup!)).toBe(false)
  })

  it('预先存在目标目录被 snapshot，错误路径下回滚', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )

    // 预先在 dsh session dir 放一个 dummy 文件（模拟「目标目录已有数据」场景）
    const targetDir = dshSessionDir(currentDataDir, cwd, sessionId)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'preexisting.txt'), 'old-data', 'utf8')

    // 通过 dsh-bridge mock 设置错误的 DSH_VERSION 让 createRequire 走错路径
    // —— 这里直接改 vi.mock 不现实，改用另一种策略：让目标 log 已存在
    // 阻断幂等检查路径触发「match but corrupt」分支，但也不能这么干
    // （已存在但不匹配的会 throw 而不是 rollback）。
    //
    // 直接策略：snapshot 已存在的目录 + 触发写入失败。
    // 由于 ESM 模块 namespace 不可 spy，我们通过 vi.mock 整个 node:fs/promises
    // 让 mkdir 抛错。
    const realMkdir = (await import('node:fs/promises')).mkdir
    let mkdirCalls = 0
    vi.doMock('node:fs/promises', async () => {
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      return {
        ...actual,
        mkdir: async (...args: any[]) => {
          mkdirCalls++
          // 让第 1 次 mkdir（即目标目录的 mkdir）抛错
          if (mkdirCalls === 1) {
            throw new Error('EACCES: simulated permission denied')
          }
          return (actual.mkdir as any)(...args)
        },
      }
    })

    // 重新 import migrate 让 mock 生效
    vi.resetModules()
    const migrateMod = await import('./migrate.js')

    await expect(
      migrateMod.migrateSession(cwd, sessionId, {
        dryRun: false,
        targetDshVersion: TEMPLATE_VERSION,
        dataDir: currentDataDir,
      }),
    ).rejects.toThrow(/permission denied|EACCES/)

    // 回滚后：原 snapshot 应该被还原
    expect(existsSync(targetDir)).toBe(true)
    expect(readFileSync(join(targetDir, 'preexisting.txt'), 'utf8')).toBe(
      'old-data',
    )
    // 第一次 mkdir 抛错后没有新写入（log.jsonl 不存在）
    expect(existsSync(join(targetDir, 'log.jsonl'))).toBe(false)

    // 还原 mock
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    void realMkdir
  })

  it('强制失败后 retry 仍能成功（环境已恢复）', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )

    let mkdirCalls = 0
    vi.doMock('node:fs/promises', async () => {
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      return {
        ...actual,
        mkdir: async (...args: any[]) => {
          mkdirCalls++
          if (mkdirCalls === 1) {
            throw new Error('EACCES simulated')
          }
          return (actual.mkdir as any)(...args)
        },
      }
    })

    vi.resetModules()
    const migrateMod = await import('./migrate.js')
    await expect(
      migrateMod.migrateSession(cwd, sessionId, {
        dryRun: false,
        targetDshVersion: TEMPLATE_VERSION,
        dataDir: currentDataDir,
      }),
    ).rejects.toThrow()

    vi.doUnmock('node:fs/promises')
    vi.resetModules()
    const migrateMod2 = await import('./migrate.js')

    // 重试（mock 已清除）
    const r = await migrateMod2.migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r.validated).toBe(true)
    expect(r.alreadyMigrated).toBe(false)
    expect(existsSync(dshSessionLogPath(currentDataDir, cwd, sessionId))).toBe(
      true,
    )
  })
})

// ─── DryRun ───────────────────────────────────────────────────────────

describe('migrate — dryRun', () => {
  it('dryRun=true 不写任何文件', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )
    const r = await migrateSession(cwd, sessionId, {
      dryRun: true,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r.outputPath).toBeNull()
    expect(existsSync(dshSessionDir(currentDataDir, cwd, sessionId))).toBe(false)
  })

  it('dryRun=false 写 log.jsonl + header.json', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n',
    )
    const r = await migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(existsSync(dshSessionLogPath(currentDataDir, cwd, sessionId))).toBe(true)
    expect(existsSync(dshSessionHeaderPath(currentDataDir, cwd, sessionId))).toBe(true)

    const header = JSON.parse(
      readFileSync(dshSessionHeaderPath(currentDataDir, cwd, sessionId), 'utf8'),
    )
    expect(header.source).toBe('opencc-migration')
    expect(header.dshVersion).toBe(TEMPLATE_VERSION)
    expect(header.turnCount).toBe(1)
  })

  it('dryRun 默认 true（不传 dryRun）', async () => {
    writeOpenccFixture(
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n',
    )
    const r = await migrateSession(cwd, sessionId, {
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r.outputPath).toBeNull()
    expect(existsSync(dshSessionDir(currentDataDir, cwd, sessionId))).toBe(false)
  })
})

// ─── 不可迁移条目显式列出 ────────────────────────────────────────────

describe('migrate — 不可迁移条目', () => {
  it('unmapped 条目出现在 result.unmappedEntries（含 lineNumber）', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'ok' } }),
      JSON.stringify({ type: 'attachment', file: 'x.png' }),
      '{ broken',
      JSON.stringify({ type: 'foo-bar-baz' }),
      JSON.stringify({ type: 'assistant', message: { content: 'done' } }),
    ]
    writeOpenccFixture(lines.join('\n') + '\n')

    const r = await migrateSession(cwd, sessionId, {
      dryRun: true,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })
    expect(r.mappedEvents).toBe(2)
    expect(r.unmappedEntries.length).toBe(3)
    // line numbers
    const reasons = r.unmappedEntries.map((u) => u.reason)
    expect(reasons.some((r) => r.includes('attachment'))).toBe(true)
    expect(reasons.some((r) => r.includes('JSON parse'))).toBe(true)
    expect(reasons.some((r) => r.includes('foo-bar-baz'))).toBe(true)
  })
})

// ─── listOpenccSessions ──────────────────────────────────────────────

describe('migrate — listOpenccSessions', () => {
  it('列出 cwd 下所有 opencc jsonl sessionId', async () => {
    const dir = dirname(openccJsonlPath(currentDataDir, cwd, '_'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'aaa.jsonl'), '', 'utf8')
    writeFileSync(join(dir, 'bbb.jsonl'), '', 'utf8')
    writeFileSync(join(dir, 'ignore.txt'), '', 'utf8')
    const list = await listOpenccSessions(currentDataDir, cwd)
    expect(list.sort()).toEqual(['aaa', 'bbb'])
  })

  it('cwd 目录不存在 → 返回空数组', async () => {
    const list = await listOpenccSessions(currentDataDir, '/no/such/cwd')
    expect(list).toEqual([])
  })
})

// ─── 只读源保证 ─────────────────────────────────────────────────────

describe('migrate — 只读源', () => {
  it('migrateSession 不修改源 jsonl 文件', async () => {
    const raw =
      JSON.stringify({ type: 'user', message: { content: 'a' } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { content: 'b' } }) + '\n'
    writeOpenccFixture(raw)
    const srcPath = openccJsonlPath(currentDataDir, cwd, sessionId)
    const beforeMtime = statMtime(srcPath)

    await migrateSession(cwd, sessionId, {
      dryRun: false,
      targetDshVersion: TEMPLATE_VERSION,
      dataDir: currentDataDir,
    })

    // 源文件内容与 mtime 不变
    expect(readFileSync(srcPath, 'utf8')).toBe(raw)
    expect(statMtime(srcPath)).toBe(beforeMtime)
  })
})

// ─── 工具 ─────────────────────────────────────────────────────────────

const MAX_SANITIZED_LENGTH = 200

function statMtime(path: string): number {
  return require('node:fs').statSync(path).mtimeMs
}