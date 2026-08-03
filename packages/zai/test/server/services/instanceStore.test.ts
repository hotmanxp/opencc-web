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

  it('returns empty file when JSON is corrupt', async () => {
    process.env.ZAI_DATA_DIR = DATA_DIR
    const path = instancesFilePath(DATA_DIR)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(path, 'not-json{', 'utf-8')
    const file = await readInstancesFile(DATA_DIR)
    expect(file).toEqual({ definitions: [], statuses: {} })
  })
})
