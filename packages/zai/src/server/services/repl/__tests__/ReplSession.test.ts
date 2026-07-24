import { describe, expect, it } from 'vitest'
import { ReplSession, ReplBusyError } from '../ReplSession.js'

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
    await s.exec('node -e "setTimeout(()=>{}, 60000)"')
    expect(s.busy).toBe(true)
    await expect(s.exec('echo second')).rejects.toBeInstanceOf(ReplBusyError)
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

    const { execId } = await s.exec('echo hello-stdout')
    await waitExit(s, execId)
    expect(events.join('')).toContain('hello-stdout')
  })

  it('stderr chunk 触发 event，kind=stderr', async () => {
    const s = new ReplSession(process.cwd())
    let stderrMsg = ''
    s.on('event', (ev: any) => { if (ev.kind === 'stderr') stderrMsg += ev.chunk })

    const { execId } = await s.exec('echo hello-stderr >&2')
    await waitExit(s, execId)
    expect(stderrMsg).toContain('hello-stderr')
  })

  it('自然 exit 触发 kind=exit 且 code=0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('true')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(0)
    expect(s.busy).toBe(false)
  })

  it('自然 exit 触发 kind=exit 且 code 非 0', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('sh -c "exit 7"')
    await waitExit(s, execId)
    expect(exits.find((e) => e.execId === execId)?.code).toBe(7)
  })

  it('abort 触发 SIGTERM exit event 含 signal', async () => {
    const s = new ReplSession(process.cwd())
    const exits: any[] = []
    s.on('event', (ev: any) => { if (ev.kind === 'exit') exits.push(ev) })

    const { execId } = await s.exec('node -e "setTimeout(()=>{}, 60000)"')
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
    const { execId } = await s.exec('this-command-does-not-exist-xyz-12345')
    await waitExit(s, execId)
    expect(stderrs.find((e) => e.execId === execId)).toBeDefined()
    expect(stderrs.find((e) => e.execId === execId)?.chunk).toContain('not found')
    const exit = exits.find((e) => e.execId === execId)
    expect(exit).toBeDefined()
    expect(exit?.code).toBe(127)
    expect(s.busy).toBe(false)
  })
})