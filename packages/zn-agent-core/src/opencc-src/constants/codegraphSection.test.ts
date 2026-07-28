import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// pwd() in src/utils/cwd.ts reads getCwdState() (captured at startup),
// so process.chdir() won't affect it. We must mock the whole cwd module.
let mockPwdPath = ''

mock.module('../utils/cwd.js', () => ({
  pwd: () => mockPwdPath,
}))

// top-level await: only import codegraphSection after the mock is set up,
// so the section's closure captures the mocked pwd reference
const { codegraphSection } = await import('./codegraphSection.js')

describe('codegraphSection', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'codegraph-test-'))
    mockPwdPath = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('codegraph.db 存在时返回完整文本', () => {
    mkdirSync(join(tempDir, '.codegraph'), { recursive: true })
    writeFileSync(join(tempDir, '.codegraph/codegraph.db'), '')

    const result = codegraphSection.compute()

    expect(result).not.toBeNull()
    expect(result).toContain('This project is indexed by CodeGraph')
    expect(result).toContain('codegraph_search')
    expect(result).toContain('codegraph_callers')
    expect(result).toContain('codegraph_node')
    expect(result).toContain('codegraph_explore')
    expect(result).toContain('staleness banner')
    // The 4 tools disabled by codegraph's default MCP surface (since v1.0.0)
    // MUST NOT appear in the system-prompt section — listing them would
    // encourage the model to call phantom tools.
    expect(result).not.toContain('codegraph_callees')
    expect(result).not.toContain('codegraph_impact')
    expect(result).not.toContain('codegraph_files')
    expect(result).not.toContain('codegraph_status')
  })

  test('.codegraph/ 目录不存在时返回 null', () => {
    // 不创建 .codegraph 目录
    const result = codegraphSection.compute()
    expect(result).toBeNull()
  })

  test('.codegraph/ 存在但 codegraph.db 缺失时返回 null', () => {
    mkdirSync(join(tempDir, '.codegraph'), { recursive: true })
    // 不写 codegraph.db

    const result = codegraphSection.compute()
    expect(result).toBeNull()
  })

  test('只有 wal/shm sidecar 无 main file 时返回 null', () => {
    mkdirSync(join(tempDir, '.codegraph'), { recursive: true })
    writeFileSync(join(tempDir, '.codegraph/codegraph.db-wal'), '')
    writeFileSync(join(tempDir, '.codegraph/codegraph.db-shm'), '')

    const result = codegraphSection.compute()
    expect(result).toBeNull()
  })

  test('codegraph.db 是空文件时仍返回完整文本', () => {
    mkdirSync(join(tempDir, '.codegraph'), { recursive: true })
    writeFileSync(join(tempDir, '.codegraph/codegraph.db'), '') // 空文件

    const result = codegraphSection.compute()
    expect(result).not.toBeNull()
  })
})
