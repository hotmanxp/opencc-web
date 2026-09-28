import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import {
  EMPTY_INSTANCE_STATUS,
  instancesFilePath,
  readInstancesFile,
  writeInstancesFile,
  type InstancesFile,
} from '../../../src/server/services/instanceStore.js'

const DATA_DIR = '/tmp/zai-test-instance-store'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch {}
})

describe('instanceStore', () => {
  it('returns empty file when path does not exist', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const file = await readInstancesFile()
    expect(file).toEqual({ definitions: [], statuses: {} })
  })

  it('round-trips definitions and statuses', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const def = { id: 'inst_1', name: 'demo', cwd: '/tmp/x', createdAt: '2026-08-03T00:00:00.000Z' }
    const status = { ...EMPTY_INSTANCE_STATUS, state: 'running' as const, port: 9202, pid: 42 }
    const file: InstancesFile = { definitions: [def], statuses: { inst_1: status } }
    await writeInstancesFile(file)
    expect(instancesFilePath(DATA_DIR)).toMatch(/instances\.json$/)
    const reloaded = await readInstancesFile(DATA_DIR)
    expect(reloaded).toEqual(file)
  })

  it('returns empty file when JSON is corrupt, and preserves the bad content', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const path = instancesFilePath(DATA_DIR)
    const { mkdir, writeFile, readFile, access } = await import('node:fs/promises')
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(path, 'not-json{', 'utf-8')
    const file = await readInstancesFile(DATA_DIR)
    expect(file).toEqual({ definitions: [], statuses: {} })
    // 坏内容留证 + 原文件挪走,重启一次就能干净地重新 hydrate。
    expect(await readFile(`${path}.corrupt`, 'utf-8')).toBe('not-json{')
    await expect(access(path)).rejects.toThrow()
  })

  it('treats an empty file as an interrupted write, not as "no instances"', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const path = instancesFilePath(DATA_DIR)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(path, '', 'utf-8') // 0 字节:被 SIGKILL 打断的覆盖写
    const file = await readInstancesFile(DATA_DIR)
    expect(file).toEqual({ definitions: [], statuses: {} })
    // 空内容也留证,否则这个「所有定义都没了」的事件永远查不到现场。
    const { access, readFile } = await import('node:fs/promises')
    await expect(access(`${path}.corrupt`)).resolves.toBeUndefined()
    expect(await readFile(`${path}.corrupt`, 'utf-8')).toBe('')
  })

  it('a corrupt file does not poison the next write', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const path = instancesFilePath(DATA_DIR)
    const { mkdir, writeFile, readFile } = await import('node:fs/promises')
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(path, 'not-json{', 'utf-8')
    await readInstancesFile(DATA_DIR) // 触发挪开
    const def = { id: 'inst_1', name: 'demo', cwd: '/tmp/x', createdAt: '2026-08-03T00:00:00.000Z' }
    await writeInstancesFile({ definitions: [def], statuses: {} })
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ definitions: [def], statuses: {} })
  })

  it('leaves no temp file behind after a successful write', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const def = { id: 'inst_1', name: 'demo', cwd: '/tmp/x', createdAt: '2026-08-03T00:00:00.000Z' }
    await writeInstancesFile({ definitions: [def], statuses: {} })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(DATA_DIR)
    // 只有 instances.json 和 proper-lockfile 的锁目录,不该残留 .tmp。
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })
})
