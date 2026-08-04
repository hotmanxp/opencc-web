import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReplSession, ReplBusyError } from '../ReplSession.js'
import {
  ReplHistoryService,
  __resetReplHistoryServiceForTest,
} from '../ReplHistoryService.js'

describe('ReplSession — 初始化与状态', () => {
  it('新建实例 busy=false', () => {
    const s = new ReplSession('/tmp')
    expect(s.busy).toBe(false)
  })

  it('cwd 默认值', () => {
    const s = new ReplSession('/tmp')
    expect(s.cwd).toBe('/tmp')
  })

  it('有 child 在跑时 exec 抛 ReplBusyError', async () => {
    const s = new ReplSession(process.cwd())
    await s.exec('node -e "setTimeout(()=>{}, 60000)"', 'test-sess')
    expect(s.busy).toBe(true)
    await expect(s.exec('echo second', 'test-sess')).rejects.toBeInstanceOf(ReplBusyError)
    s.abort()
  })
})

async function waitExit(s: ReplSession, execId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (!s.busy) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ReplSession — stdout / stderr / exit', () => {
  it('stdout chunk 触发 event', async () => {
    const s = new ReplSession(process.cwd())
    const events: string[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'stdout') events.push(ev.chunk) })

    const { execId } = await s.exec('echo hello-stdout', 'test-sess')
    await waitExit(s, execId)
    expect(events.join('')).toContain('hello-stdout')
  })

  it('stderr chunk 触发 event，kind=stderr', async () => {
    const s = new ReplSession(process.cwd())
    let stderrMsg = ''
    s.on('event', (ev: any) => { if (ev.kind === 'stderr') stderrMsg += ev.chunk })

    const { execId } = await s.exec('echo hello-stderr >&2', 'test-sess')
    await waitExit(s, execId)
    expect(stderrMsg).toContain('hello-stderr')
  })

  it('自然 exit 触发 kind=exit 且 code=0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('true', 'test-sess')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(0)
    expect(s.busy).toBe(false)
  })

  it('自然 exit 触发 kind=exit 且 code 非 0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('sh -c "exit 7"', 'test-sess')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(7)
  })

  it('abort 触发 SIGTERM exit event 含 signal', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('node -e "setTimeout(()=>{}, 60000)"', 'test-sess')
    expect(s.busy).toBe(true)
    s.abort()
    await waitExit(s, execId)
    const exit = exits.find((e) => e.execId === execId)
    expect(exit?.signal).toBe('SIGTERM')
    expect(s.busy).toBe(false)
  })

  it('dispose 后 busy=false', () => {
    const s = new ReplSession('/tmp')
    s.dispose()
    expect(s.busy).toBe(false)
  })

  // 替换原 brief 中"不存在的命令 → exec 抛 ReplSpawnError"。
  // 原断言错误：spawn('sh', ['-c', cmd]) 同步成功,unknown command 由 sh 自身
  // 报告：emit kind:'stderr' ("command not found") + kind:'exit' (code 127),
  // exec() resolve 正常。busy=false 表示 child 已结束、可接收下一条 exec。
  it('不存在的命令 → emit kind:stderr + kind:exit(code 127) + busy=false', async () => {
    const s = new ReplSession(process.cwd())
    const stderrs: any[] = []
    const exits: any[] = []
    s.on('event', (ev: any) => {
      if (ev.kind === 'stderr') stderrs.push(ev)
      if (ev.kind === 'exit') exits.push(ev)
    })

    // 不 reject — spawn 成功,sh 退出码 127。
    const { execId } = await s.exec('this-command-does-not-exist-xyz-12345', 'test-sess')
    await waitExit(s, execId)
    expect(stderrs.find((e) => e.execId === execId)).toBeDefined()
    expect(stderrs.find((e) => e.execId === execId)?.chunk).toContain('not found')
    const exit = exits.find((e) => e.execId === execId)
    expect(exit).toBeDefined()
    expect(exit?.code).toBe(127)
    expect(s.busy).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Task 2 集成测试 — ReplSession.exec 写历史
// -----------------------------------------------------------------------------

describe('ReplSession — 全局命令历史集成 (Task 2)', () => {
  let tmpDir: string
  let historyPath: string
  let history: ReplHistoryService

  beforeEach(() => {
    __resetReplHistoryServiceForTest()
    tmpDir = mkdtempSync(join(tmpdir(), 'zai-repl-history-'))
    historyPath = join(tmpDir, 'history.jsonl')
    history = new ReplHistoryService({ historyPath })
  })

  afterEach(() => {
    __resetReplHistoryServiceForTest()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function readLines(): string[] {
    try {
      return readFileSync(historyPath, 'utf-8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  it('exec spawn 成功 → history 写入一条 JSONL (含 sessionId)', async () => {
    const s = new ReplSession(process.cwd(), { historyService: history })
    const { execId } = await s.exec('echo history-test-cmd', 'sess-A')
    await waitExit(s, execId)
    // appendCommand 是 fire-and-forget,等微任务 tick 让 promise 链收尾
    await new Promise((r) => setImmediate(r))
    const lines = readLines()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.command).toBe('echo history-test-cmd')
    expect(parsed.sessionId).toBe('sess-A')
    expect(typeof parsed.ts).toBe('number')
  })

  it('多个 exec 顺序写 → 历史里出现多条', async () => {
    const s = new ReplSession(process.cwd(), { historyService: history })
    const a = await s.exec('echo alpha', 'sess-X')
    await waitExit(s, a.execId)
    const b = await s.exec('echo beta', 'sess-X')
    await waitExit(s, b.execId)
    await new Promise((r) => setImmediate(r))
    const lines = readLines()
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.some((l) => JSON.parse(l).command === 'echo alpha')).toBe(true)
    expect(lines.some((l) => JSON.parse(l).command === 'echo beta')).toBe(true)
  })

  it('不同 sessionId 写入同一条历史文件', async () => {
    const s1 = new ReplSession(process.cwd(), { historyService: history })
    const s2 = new ReplSession('/tmp', { historyService: history })
    const a = await s1.exec('echo shared', 'sess-1')
    await waitExit(s1, a.execId)
    const b = await s2.exec('echo shared', 'sess-2')
    await waitExit(s2, b.execId)
    await new Promise((r) => setImmediate(r))
    const lines = readLines()
    expect(lines.length).toBe(2)
    const sids = lines.map((l) => JSON.parse(l).sessionId).sort()
    expect(sids).toEqual(['sess-1', 'sess-2'])
  })

  it('blocklist 命中命令不写入历史', async () => {
    const s = new ReplSession(process.cwd(), { historyService: history })
    const { execId } = await s.exec('export PASSWORD=secret123', 'sess-B')
    await waitExit(s, execId)
    await new Promise((r) => setImmediate(r))
    expect(readLines()).toHaveLength(0)
  })

  it('exit code 非 0 仍然写入历史 (plan §3.5)', async () => {
    const s = new ReplSession(process.cwd(), { historyService: history })
    const { execId } = await s.exec('sh -c "exit 9"', 'sess-C')
    await waitExit(s, execId)
    await new Promise((r) => setImmediate(r))
    const lines = readLines()
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).command).toBe('sh -c "exit 9"')
  })

  it('historyService 失败不影响 exec 返回', async () => {
    // 用一个永远 reject 的 historyService 模拟写入失败
    const broken = {
      appendCommand: () => Promise.reject(new Error('disk full')),
      getTopCommands: () => Promise.resolve([]),
      invalidateCache: () => {},
    } as unknown as ReplHistoryService
    const s = new ReplSession(process.cwd(), { historyService: broken })
    // 即使 appendCommand reject,exec 仍然 resolve
    const { execId } = await s.exec('echo no-throw', 'sess-D')
    expect(typeof execId).toBe('string')
    await waitExit(s, execId)
  })
})