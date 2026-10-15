import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
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

// 复刻 npmPermissions 里的落盘路径推导(win32 无 lib 一层)。测试直接按平台
// 摆出对应的目录布局,断言门禁对这组路径逐层判定。
const ROOT_SEGMENTS = process.platform === 'win32' ? ['node_modules'] : ['lib', 'node_modules']
const BIN_SEGMENTS = process.platform === 'win32' ? [] : ['bin']

/** 造出 prefix 下的安装目录,返回最深那层路径。 */
function makeInstallDir(prefix: string, segments: string[]): string {
  const p = join(prefix, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}

/** 递归恢复写权限 —— 只 chmod 顶层删不掉测试里置成 r-x 的子目录。 */
function restoreWrite(dir: string): void {
  if (!existsSync(dir)) return
  try {
    chmodSync(dir, 0o700)
  } catch {
    return
  }
  for (const name of readdirSync(dir)) restoreWrite(join(dir, name))
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'zai-npmperm-'))
  mockExecFile.mockReset()
  vi.resetModules()
})

afterEach(() => {
  restoreWrite(workDir)
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

  // 以下三条覆盖「prefix 本身可写,但 npm 真正的落盘点不可写」的布局 ——
  // 只探 prefix 一层会漏判,放行后仍由 npm 自己撞 EACCES 喷原始堆栈。

  it('returns writable=false when prefix is writable but the global root below it is not', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    const prefix = join(workDir, 'prefix')
    mkdirSync(prefix)
    chmodSync(makeInstallDir(prefix, ROOT_SEGMENTS), 0o500) // root-owned 残留
    stubPrefix(prefix)
    const r = await probeGlobalPrefixWritable()
    expect(r).toEqual({ writable: false, prefix })
  })

  // win32 下 npm 把命令 shim 直接落在 prefix(BIN_SEGMENTS 为空),没有独立的
  // bin 层可测,跳过以免退化成「测 prefix 可写性」的假阳性。
  it.skipIf(process.platform === 'win32')('returns writable=false when the bin dir exists but is not writable', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    const prefix = join(workDir, 'prefix')
    mkdirSync(prefix)
    makeInstallDir(prefix, ROOT_SEGMENTS) // 包目录正常可写
    chmodSync(makeInstallDir(prefix, BIN_SEGMENTS), 0o500) // 命令软链目录才是瓶颈
    stubPrefix(prefix)
    const r = await probeGlobalPrefixWritable()
    expect(r).toEqual({ writable: false, prefix })
  })

  it('returns writable=true when prefix and every existing install dir are writable', async () => {
    const { probeGlobalPrefixWritable } = await import('../../../src/server/services/npmPermissions.js')
    const prefix = join(workDir, 'prefix')
    mkdirSync(prefix)
    makeInstallDir(prefix, ROOT_SEGMENTS)
    makeInstallDir(prefix, BIN_SEGMENTS)
    stubPrefix(prefix)
    const r = await probeGlobalPrefixWritable()
    expect(r).toEqual({ writable: true, prefix })
  })
})