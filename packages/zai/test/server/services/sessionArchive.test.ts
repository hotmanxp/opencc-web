import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '@zn-ai/zn-agent-core'
import {
  ARCHIVE_KEEP_COUNT_DEFAULT,
  ARCHIVE_KEEP_COUNT_MAX,
  ARCHIVE_KEEP_COUNT_MIN,
  __resetSessionArchiveForTests,
  archiveDirFor,
  projectDirFor,
  resolveArchiveKeepCount,
  sweepSessionArchive,
  toArchiveKeepCount,
} from '../../../src/server/services/sessionArchive.js'

// stat 需要被 mock —— 「扫描后被并发写入」的保护窗分支只能靠 mock 复现
// （见该用例注释）。其余函数透传。这个手法与 test/server/historyArchive.test.ts:8-11
// mock readdir 是同一款。
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  return { ...orig, stat: vi.fn(orig.stat) }
})

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'session-archive-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('路径派生', () => {
  it('源目录 = <dataDir>/projects/<encoded>，目标 = <dataDir>/archive/projects/<encoded>', () => {
    const cwd = '/Users/foo/code/bar'
    expect(projectDirFor(dataDir, cwd)).toBe(
      join(dataDir, 'projects', '-Users-foo-code-bar'),
    )
    expect(archiveDirFor(dataDir, cwd)).toBe(
      join(dataDir, 'archive', 'projects', '-Users-foo-code-bar'),
    )
  })

  // 这条是防漂移的关键回归测试：断言"真实落盘目录"与 projectDirFor 一致。
  // 两者的编码都来自 core 导出的同一个 sanitizePath，但 TranscriptStore 未来
  // 若换编码，这条会立刻红 —— 不要把算法抄进测试里再断言算法。
  it('projectDirFor 与 TranscriptStore 真实落盘的目录一致', async () => {
    const cwd = '/Users/foo/code/drift-check'
    const store = new TranscriptStore(dataDir)
    await store.create({ cwd, model: 'test-model' }, { cwd })
    expect(fs.existsSync(projectDirFor(dataDir, cwd))).toBe(true)
  })
})

describe('toArchiveKeepCount', () => {
  it('合法数字原样返回（取整）', () => {
    expect(toArchiveKeepCount(50)).toBe(50)
    expect(toArchiveKeepCount(50.9)).toBe(50)
  })

  it('可转数字的字符串也接受（与 max-visible-messages 同款宽容度）', () => {
    expect(toArchiveKeepCount('50')).toBe(50)
  })

  it('clamp 至 [1, 1000]', () => {
    expect(toArchiveKeepCount(0)).toBe(ARCHIVE_KEEP_COUNT_MIN)
    expect(toArchiveKeepCount(-10)).toBe(ARCHIVE_KEEP_COUNT_MIN)
    expect(toArchiveKeepCount(1e9)).toBe(ARCHIVE_KEEP_COUNT_MAX)
  })

  it('非法输入返回 null', () => {
    expect(toArchiveKeepCount(undefined)).toBeNull()
    expect(toArchiveKeepCount(null)).toBeNull()
    expect(toArchiveKeepCount('abc')).toBeNull()
    expect(toArchiveKeepCount(NaN)).toBeNull()
    expect(toArchiveKeepCount(Infinity)).toBeNull()
  })
})

describe('resolveArchiveKeepCount', () => {
  it('缺失 / 非法值 → 默认 20', () => {
    expect(resolveArchiveKeepCount({})).toBe(ARCHIVE_KEEP_COUNT_DEFAULT)
    expect(
      resolveArchiveKeepCount({ archive: { keepCount: 'junk' as never } }),
    ).toBe(ARCHIVE_KEEP_COUNT_DEFAULT)
  })

  it('读得到就 clamp 后返回', () => {
    expect(resolveArchiveKeepCount({ archive: { keepCount: 5 } })).toBe(5)
    expect(resolveArchiveKeepCount({ archive: { keepCount: 99999 } })).toBe(
      ARCHIVE_KEEP_COUNT_MAX,
    )
  })
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0) // 固定墙钟，测试不依赖 Date.now()

/** 在源目录铺一个 <sid>.jsonl，并把 mtime 设成 daysAgo 天前。 */
async function seedSession(
  cwd: string,
  sessionId: string,
  daysAgo: number,
  opts: { withSubagentDir?: boolean } = {},
): Promise<void> {
  const dir = projectDirFor(dataDir, cwd)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sessionId}${'.jsonl'}`)
  await writeFile(file, `${JSON.stringify({ type: 'user', message: sessionId })}\n`, 'utf-8')
  const t = new Date(NOW - daysAgo * DAY_MS)
  await utimes(file, t, t)
  if (opts.withSubagentDir) {
    const sub = join(dir, sessionId, 'subagents')
    await mkdir(sub, { recursive: true })
    await writeFile(join(sub, 'agent-x.jsonl'), '{}\n', 'utf-8')
  }
}

const listDir = (p: string): string[] =>
  fs.existsSync(p) ? fs.readdirSync(p).sort() : []

const CWD = '/Users/foo/code/archive-target'

beforeEach(() => {
  __resetSessionArchiveForTests()
})

describe('sweepSessionArchive 判定', () => {
  it('超出阈值：25 条、最老 5 条在 5 天前 → 归档 5 条', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-new${i}`, 1)
    for (let i = 0; i < 5; i++) await seedSession(CWD, `sess-old${i}`, 5)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived.sort()).toEqual([
      'sess-old0', 'sess-old1', 'sess-old2', 'sess-old3', 'sess-old4',
    ])
    expect(res.kept).toBe(20)
    expect(res.skipped).toBe(0)
    expect(listDir(archiveDirFor(dataDir, CWD))).toEqual([
      'sess-old0.jsonl', 'sess-old1.jsonl', 'sess-old2.jsonl', 'sess-old3.jsonl', 'sess-old4.jsonl',
    ])
  })

  it('3 天窗口保护：25 条全部 1 天前 → 归档 0 条（数量超了但都在窗口内）', async () => {
    for (let i = 0; i < 25; i++) await seedSession(CWD, `sess-recent${i}`, 1)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual([])
    expect(res.kept).toBe(25)
    expect(listDir(projectDirFor(dataDir, CWD))).toHaveLength(25)
  })

  it('并集语义：22 条中排序在 20 名之外的 2 条若在 3 天内则不动', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-a${i}`, 1)
    await seedSession(CWD, 'sess-b0', 2) // 第 21 名，但 2 天前 → 保留
    await seedSession(CWD, 'sess-b1', 5) // 第 22 名且 5 天前 → 归档
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-b1'])
    expect(res.kept).toBe(21)
  })

  it('候选数 ≤ keepCount → 直接返回，不归档', async () => {
    for (let i = 0; i < 3; i++) await seedSession(CWD, `sess-few${i}`, 30)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual([])
    expect(res.kept).toBe(3)
  })

  it('保护窗：扫描后被并发写入的会话不移动(skipped 计数)', async () => {
    // 保护窗可达的唯一路径是"扫描与写入撞车"：第一次 stat(候选扫描)看到旧
    // mtime → 进归档集；第二次 stat(移动前的 re-stat)看到刚刚被写入的新
    // mtime → 跳过。判断条件本身(早于 3 天)与保护窗(10 分钟)不可能同时成立，
    // 所以只能 mock 出撞车。第二次 stat 存在的意义就是抓这个窗口。
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-p${i}`, 1)
    await seedSession(CWD, 'sess-raced0', 5)

    const statSpy = vi.mocked(stat)
    const defaultImpl = statSpy.getMockImplementation()
    let reads = 0
    statSpy.mockImplementation((async (p: unknown, ...rest: unknown[]) => {
      const s = await (defaultImpl as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
      if (typeof p === 'string' && p.endsWith('sess-raced0.jsonl')) {
        reads++
        if (reads >= 2) {
          // 第二次读 = 移动前的 re-stat → 模拟"这个会话刚被恢复并写入"
          return { ...(s as object), mtimeMs: NOW - 60_000 }
        }
      }
      return s
    }) as unknown as typeof stat)

    try {
      const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
      expect(res.archived).toEqual([])
      expect(res.skipped).toBe(1)
      expect(reads).toBe(2)
      expect(
        fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-raced0.jsonl')),
      ).toBe(true)
    } finally {
      statSpy.mockImplementation(defaultImpl!)
    }
  })
})

describe('sweepSessionArchive 归档单元', () => {
  it('<sid>/ 子 Agent 目录随行归档', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-k${i}`, 1)
    await seedSession(CWD, 'sess-withsub', 5, { withSubagentDir: true })
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-withsub'])
    const dst = archiveDirFor(dataDir, CWD)
    expect(fs.existsSync(join(dst, 'sess-withsub.jsonl'))).toBe(true)
    expect(fs.existsSync(join(dst, 'sess-withsub', 'subagents', 'agent-x.jsonl'))).toBe(true)
    // 源目录里不再有孤儿目录
    expect(fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-withsub'))).toBe(false)
  })

  it('0 字节占位文件同规则参与判定', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-z${i}`, 1)
    const dir = projectDirFor(dataDir, CWD)
    const empty = join(dir, 'sess-empty0.jsonl')
    await writeFile(empty, '', 'utf-8')
    const t = new Date(NOW - 10 * DAY_MS)
    await utimes(empty, t, t)
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(res.archived).toEqual(['sess-empty0'])
  })

  it('project 目录不存在 → 空结果不抛', async () => {
    const res = await sweepSessionArchive({
      cwd: '/Users/nobody/never-ran', dataDir, now: NOW, keepCount: 20,
    })
    expect(res).toEqual({ archived: [], kept: 0, skipped: 0 })
  })
})

describe('sweepSessionArchive 容错', () => {
  it('非会话文件 / 目录不受影响', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-m${i}`, 1)
    await seedSession(CWD, 'sess-doomed', 5)
    const dir = projectDirFor(dataDir, CWD)
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'memory', 'MEMORY.md'), '# mem\n', 'utf-8')
    await writeFile(join(dir, 'knowledge_graph.json'), '{}\n', 'utf-8')
    await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(fs.existsSync(join(dir, 'memory', 'MEMORY.md'))).toBe(true)
    expect(fs.existsSync(join(dir, 'knowledge_graph.json'))).toBe(true)
  })

  it('目标同名 → warn 跳过，源文件保留', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-c${i}`, 1)
    await seedSession(CWD, 'sess-conflict', 5)
    const dst = archiveDirFor(dataDir, CWD)
    await mkdir(dst, { recursive: true })
    await writeFile(join(dst, 'sess-conflict.jsonl'), 'preexisting\n', 'utf-8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    warnSpy.mockRestore()
    expect(res.archived).toEqual([])
    expect(res.skipped).toBe(1)
    expect(fs.existsSync(join(projectDirFor(dataDir, CWD), 'sess-conflict.jsonl'))).toBe(true)
  })

  it('并发调用复用同一 in-flight sweep（同一 Promise 实例）', async () => {
    for (let i = 0; i < 20; i++) await seedSession(CWD, `sess-i${i}`, 1)
    await seedSession(CWD, 'sess-lone0', 5)
    const p1 = sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    const p2 = sweepSessionArchive({ cwd: CWD, dataDir, now: NOW, keepCount: 20 })
    expect(p1).toBe(p2)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.archived).toEqual(['sess-lone0'])
  })
})
