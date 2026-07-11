import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { abortSession } from '../../src/runtime/abort.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-abort-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('abortSession', () => {
  test('writes abort file', async () => {
    await abortSession({ dataDir: tmpDir }, 'sess-test', 'user cancelled')
    const content = await readFile(join(tmpDir, 'runtime', 'aborts', 'sess-test.abort'), 'utf-8')
    const data = JSON.parse(content)
    expect(data.sessionId).toBe('sess-test')
    expect(data.reason).toBe('user cancelled')
  })
})