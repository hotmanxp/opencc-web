import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { startMemoryWatcher, stopMemoryWatcher } from '../../src/agents/memoryWatcher.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-watcher-test-'))
})

afterEach(async () => {
  stopMemoryWatcher()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('memoryWatcher', () => {
  test('startMemoryWatcher returns a handle with stop()', () => {
    const handle = startMemoryWatcher({ cwd: tmpDir })
    expect(handle).toBeDefined()
    expect(typeof handle.stop).toBe('function')
    handle.stop()
  })

  test('does not throw when cwd has no AGENTS.md', () => {
    expect(() => startMemoryWatcher({ cwd: tmpDir })).not.toThrow()
  })

  test('stopMemoryWatcher is idempotent', () => {
    startMemoryWatcher({ cwd: tmpDir })
    expect(() => stopMemoryWatcher()).not.toThrow()
    expect(() => stopMemoryWatcher()).not.toThrow() // second call no-op
  })
})
