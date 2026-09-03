import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// readdir 计数用于验证 in-flight 去重(并发 sweep 只扫一次);其余函数透传。
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  return { ...orig, readdir: vi.fn(orig.readdir) }
})

import { readdir } from 'node:fs/promises'
import {
  HISTORY_BUCKET,
  __resetForTests,
  sweepArchiveFinishedTasks,
} from '../../src/server/services/historyArchive.js'
import {
  __resetForTests as resetSettings,
  factorySettingsPath,
} from '../../src/server/services/factorySettings.js'

let dataDir: string
let tfDir: string
const finishedDir = () => join(tfDir, 'finished-tasks')
const historyDir = () => join(tfDir, HISTORY_BUCKET)

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()

/** 构造 task.yaml 文本;不传 completedAt = 字段缺失。 */
function taskYaml(status: string, completedAt?: string): string {
  const lines = ['title: t', `status: ${status}`]
  if (completedAt !== undefined) lines.push(`completedAt: '${completedAt}'`)
  return `${lines.join('\n')}\n`
}

async function makeFinishedTask(
  id: string,
  yamlText: string,
  opts: { mtime?: Date; withDocs?: boolean } = {},
): Promise<void> {
  const dir = join(finishedDir(), id)
  await mkdir(dir, { recursive: true })
  if (opts.withDocs) {
    await mkdir(join(dir, 'docs'), { recursive: true })
    await writeFile(join(dir, 'docs', 'spec.md'), '# spec\n', 'utf-8')
  }
  const yamlPath = join(dir, 'task.yaml')
  await writeFile(yamlPath, yamlText, 'utf-8')
  if (opts.mtime) await utimes(yamlPath, opts.mtime, opts.mtime)
}

const listDir = (p: string): string[] => (fs.existsSync(p) ? fs.readdirSync(p) : [])

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'history-archive-data-'))
  tfDir = await mkdtemp(join(tmpdir(), 'history-archive-tf-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.ZAI_TASK_FACTORY_DIR = tfDir
})

afterAll(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dataDir, { recursive: true, force: true })
  await rm(tfDir, { recursive: true, force: true })
})

beforeEach(async () => {
  __resetForTests()
  resetSettings()
  await rm(finishedDir(), { recursive: true, force: true })
  await rm(historyDir(), { recursive: true, force: true })
  await mkdir(finishedDir(), { recursive: true })
})

afterEach(async () => {
  await rm(factorySettingsPath(), { force: true })
  resetSettings()
})

describe('sweepArchiveFinishedTasks 基本归档', () => {
  it('done + failed 超阈值均归档,目录整体移动且内容完整(含 docs/)', async () => {
    await makeFinishedTask('tf-done0001', taskYaml('done', hoursAgo(100)), { withDocs: true })
    await makeFinishedTask('tf-fail0001', taskYaml('failed', hoursAgo(100)))
    const { archived } = await sweepArchiveFinishedTasks()
    expect([...archived].sort()).toEqual(['tf-done0001', 'tf-fail0001'])
    expect(listDir(finishedDir())).toEqual([])
    expect(listDir(historyDir()).sort()).toEqual(['tf-done0001', 'tf-fail0001'])
    expect(fs.existsSync(join(historyDir(), 'tf-done0001', 'docs', 'spec.md'))).toBe(true)
    expect(fs.existsSync(join(historyDir(), 'tf-done0001', 'task.yaml'))).toBe(true)
  })

  it('非终态(done/failed 之外)不动', async () => {
    await makeFinishedTask('tf-proc0001', taskYaml('processing', hoursAgo(100)))
    await makeFinishedTask('tf-queu0001', taskYaml('queued', hoursAgo(100)))
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual([])
    expect(listDir(finishedDir()).sort()).toEqual(['tf-proc0001', 'tf-queu0001'])
    expect(listDir(historyDir())).toEqual([])
  })

  it('阈值内(completedAt 未过期)不归档', async () => {
    await makeFinishedTask('tf-rec00001', taskYaml('done', hoursAgo(1)))
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual([])
    expect(listDir(finishedDir())).toEqual(['tf-rec00001'])
  })

  it('historyArchiveHours 覆盖默认 48 生效(设 1 后 2 小时前的任务归档)', async () => {
    await makeFinishedTask('tf-ovr00001', taskYaml('done', hoursAgo(2)))
    await writeFile(factorySettingsPath(), JSON.stringify({ historyArchiveHours: 1 }), 'utf-8')
    resetSettings()
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual(['tf-ovr00001'])
    expect(listDir(historyDir())).toEqual(['tf-ovr00001'])
  })
})

describe('过期判定回落', () => {
  it('completedAt 缺失 → task.yaml mtime 回落(旧 mtime → 归档)', async () => {
    await makeFinishedTask('tf-nocompl1', taskYaml('done'), {
      mtime: new Date(Date.now() - 100 * 3_600_000),
    })
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual(['tf-nocompl1'])
    expect(listDir(historyDir())).toEqual(['tf-nocompl1'])
  })

  it('completedAt 非法字符串 → mtime 回落(新 mtime → 不归档)', async () => {
    await makeFinishedTask('tf-baddate1', taskYaml('done', 'not-a-date'))
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual([])
    expect(listDir(finishedDir())).toEqual(['tf-baddate1'])
  })

  it('completedAt 有效时 mtime 不参与(新 mtime + 旧 completedAt → 归档)', async () => {
    await makeFinishedTask('tf-oldtime1', taskYaml('done', hoursAgo(100)))
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual(['tf-oldtime1'])
  })
})

describe('sweep 容错与并发', () => {
  it('task.yaml 坏 yaml / 缺失 → warn 跳过,不抛出,其余任务照常归档', async () => {
    await makeFinishedTask('tf-broken1', 'status: [unclosed\n')
    const dirNoYaml = join(finishedDir(), 'tf-noyaml01')
    await mkdir(dirNoYaml, { recursive: true })
    await makeFinishedTask('tf-good00001', taskYaml('done', hoursAgo(100)))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { archived } = await sweepArchiveFinishedTasks()
    warnSpy.mockRestore()
    expect(archived).toEqual(['tf-good00001'])
    expect(listDir(finishedDir()).sort()).toEqual(['tf-broken1', 'tf-noyaml01'])
  })

  it('history-tasks 同名目标 → warn 跳过不抛,源目录保留', async () => {
    await makeFinishedTask('tf-conflict', taskYaml('done', hoursAgo(100)))
    await mkdir(join(historyDir(), 'tf-conflict'), { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { archived } = await sweepArchiveFinishedTasks()
    warnSpy.mockRestore()
    expect(archived).toEqual([])
    expect(listDir(finishedDir())).toEqual(['tf-conflict'])
  })

  it('finished-tasks 目录不存在 → 空结果不抛', async () => {
    await rm(finishedDir(), { recursive: true, force: true })
    const { archived } = await sweepArchiveFinishedTasks()
    expect(archived).toEqual([])
  })

  it('并发调用复用同一 in-flight sweep(readdir 只扫一次)', async () => {
    await makeFinishedTask('tf-concur01', taskYaml('done', hoursAgo(100)))
    const readdirSpy = vi.mocked(readdir)
    readdirSpy.mockClear()
    const p1 = sweepArchiveFinishedTasks()
    const p2 = sweepArchiveFinishedTasks()
    expect(p1).toBe(p2) // 同一 Promise 实例 = 去重生效
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.archived).toEqual(['tf-concur01'])
    expect(readdirSpy).toHaveBeenCalledTimes(1)
  })
})
