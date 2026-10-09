import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// npmPermissions 的探测分两步:① `npm config get prefix` 拿目录,
// ② fs.access 判可写。① 靠 mock child_process 控制(不真跑 npm),
// ② 用真实文件系统 —— 权限位是这块逻辑的核心,不适合再 mock 一层。
const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

// promisify(execFile) 需要 callback 风格的 mock:成功时回调 (null, {stdout})。
function stubPrefix(stdout: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr: '' })
  })
}
function stubPrefixError() {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error('npm not found'))
  })
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zai-npmperm-'))
  mockExecFile.mockReset()
  vi.resetModules()
})

afterEach(() => {
  // 恢复写权限,否则 rmSync 删不掉只读目录。
  chmodSync(workDir, 0o700)
  rmSync(workDir, { recursive: true, force: true })
})

describe('probeGlobalPrefixWritable', () => {
  it('returns writable=true for an existing writable dir', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    stubPrefix(workDir + '\n')
    const r = await probeGlobalPrefixWritable()
    expect(r).toEqual({ writable: true, prefix: workDir })
  })

  it('returns writable=false for an existing non-writable dir', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    chmodSync(workDir, 0o500) // r-x —— 不可写
    stubPrefix(workDir)
    const r = await probeGlobalPrefixWritable()
    expect(r.writable).toBe(false)
    expect(r.prefix).toBe(workDir)
  })

  it('returns writable=true when prefix does not exist but parent is writable', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    const notYet = join(workDir, 'not-created-yet')
    stubPrefix(notYet)
    const r = await probeGlobalPrefixWritable()
    // npm 会自建该目录 —— 父目录可写即视为可安装。
    expect(r).toEqual({ writable: true, prefix: notYet })
  })

  it('returns writable=false when prefix does not exist and parent is not writable', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    const roParent = join(workDir, 'ro')
    mkdirSync(roParent)
    chmodSync(roParent, 0o500)
    stubPrefix(join(roParent, 'child'))
    const r = await probeGlobalPrefixWritable()
    expect(r.writable).toBe(false)
  })

  it('returns writable=null (fail-open) when the prefix probe itself fails', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    stubPrefixError()
    const r = await probeGlobalPrefixWritable()
    // null = 无法判定,调用方按可写处理,不因探测失败阻断升级。
    expect(r).toEqual({ writable: null, prefix: null })
  })

  it('returns writable=null when prefix output is empty', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    stubPrefix('   \n')
    const r = await probeGlobalPrefixWritable()
    expect(r).toEqual({ writable: null, prefix: null })
  })
})