/**
 * 回归测试 — `starting` 窗口内的 stop / restart 不得静默 no-op (wb-004)。
 *
 * 缺陷(`doStop` 的 starting 早退):`entry.child` 在 `starting` 期间还是 null,
 * 此时 `doStop` 走 `if (entry.status.state === 'starting') return snapshotOf(entry)`
 * —— 返回一个**看起来正常的成功快照**,而实际什么都没做。
 *
 * 实测轨迹(注入 probePort 把窗口撑开,非推测):
 *   before:stopped → probe:enter → during-start:starting
 *   → 窗口内 stopInstance → stop-returned-immediately:starting   ← 假成功
 *   → probe:exit → spawn → final:starting                          ← 永远卡在 starting
 * 两个后果:
 *   1. 调用方拿到 200 + 正常快照,以为 stop/restart 成功了,实际原封不动。
 *   2. 请求被**丢弃**而非排队 —— in-flight start 跑完后没有任何东西去执行它。
 *
 * `routes/instances.ts` 的 `serializeLifecycle` 按 id 排队挡住了 UI 双击那条
 * 路径;真正踩得到的是绕过该闸的调用方(weixinDedicatedInstance、
 * aaClient/reverseDispatch、supervisor 自身的 IPC restart)。
 *
 * 修法:在 supervisor 层解决(不指望 HTTP 层排队兜住)—— `starting` 窗口内的
 * stop/restart 必须**等 in-flight start 结束再执行**,而不是各返回一次假成功。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** 撑开 `starting` 窗口的门:probePort 进来后一直等到 open=false。 */
const PROBE_GATE = { open: true }

let pidCounter = 40000
/** 本次用例内被 spawn 出来的 child(断言用)。 */
let spawned: ChildProcess[] = []

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; pid: number }
  child.killed = false
  child.pid = pidCounter++
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn((sig?: unknown) => {
    child.killed = true
    setTimeout(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
    }, 5)
    return true
  }) as unknown as ChildProcess['kill']
  return child as ChildProcess
}

afterEach(() => {
  PROBE_GATE.open = true
  spawned = []
  pidCounter = 40000
  vi.resetModules()
})

/** supervisor 的公开面是 getSnapshots()(无单查 API),按 id 取状态。 */
function stateOf(sup: { getSnapshots: () => Array<{ id: string; state: string }> }, id: string) {
  return sup.getSnapshots().find((s) => s.id === id)?.state
}

async function makeSup(dataDir: string, cwd: string, target: string) {
  process.env.ZAI_DATA_DIR = dataDir
  const { initInstanceSupervisor } = await import('../../src/server/services/instanceSupervisor.js')
  let probeEntered: () => void = () => {}
  const probeEnteredPromise = new Promise<void>((r) => {
    probeEntered = r
  })
  const sup = await initInstanceSupervisor({
    cwd,
    dataDir,
    deps: {
      readFile: async () =>
        ({
          version: 1,
          definitions: [{ id: 'i1', name: 'target', cwd: target, lan: false }],
          statuses: {},
        }) as never,
      writeFile: async () => {},
      emit: () => {},
      now: () => Date.now(),
      sleep: async () => {},
      assertPortAvailable: async () => {},
      probePort: async () => {
        probeEntered()
        while (PROBE_GATE.open) await new Promise((r) => setTimeout(r, 5))
        return 9300
      },
      spawn: () => {
        const c = makeFakeChild()
        spawned.push(c)
        return c
      },
    },
  })
  return { sup, probeEnteredPromise }
}

describe('instanceSupervisor — starting 窗口内的 stop/restart (wb-004)', () => {
  it('starting 期间 stop:请求不得被丢弃,实例最终落到 stopped', async () => {
    const { sup, probeEnteredPromise } = await makeSup(
      '/tmp/zai-wb004-a',
      '/tmp/wb004-cur-a',
      '/tmp/wb004-t-a',
    )
    PROBE_GATE.open = true
    const startPromise = sup.startInstance('i1')
    await probeEnteredPromise
    expect(stateOf(sup, 'i1'), '此刻应处于 starting').toBe('starting')

    PROBE_GATE.open = false
    const stopPromise = sup.stopInstance('i1')
    await startPromise
    await stopPromise
    // 给 stop 的实际执行留出余量(它可能排在 in-flight start 之后)
    await new Promise((r) => setTimeout(r, 120))

    expect(stateOf(sup, 'i1'), 'starting 窗口内的 stop 被静默丢弃 —— 实例卡在 starting,从不落地').toBe(
      'stopped',
    )
  })

  it('starting 期间 restart:必须真正重启(产生新的 child)', async () => {
    const { sup, probeEnteredPromise } = await makeSup(
      '/tmp/zai-wb004-b',
      '/tmp/wb004-cur-b',
      '/tmp/wb004-t-b',
    )
    PROBE_GATE.open = true
    const startPromise = sup.startInstance('i1')
    await probeEnteredPromise
    expect(stateOf(sup, 'i1')).toBe('starting')

    PROBE_GATE.open = false
    const restartPromise = sup.restartInstance('i1')
    await startPromise
    await restartPromise
    await new Promise((r) => setTimeout(r, 150))

    // 旧实现:stop 与 start 各自被 starting 守卫挡回 → 净效果 no-op,
    // 一个新 child 都不会被 spawn。
    expect(spawned.length, 'restart 被静默丢弃 —— 没有新 child 被 spawn').toBeGreaterThanOrEqual(2)
  })

  it('已 stop 之后重复 stop 不产生额外副作用(不得复活实例)', async () => {
    // 回归护栏:修 starting 窗口时容易顺手把「重复请求」也变成排队,
    // 那会让后续 stop 打到已经死掉的 child 上。
    //
    // 刻意**不**断言 kill 次数:`doStop` 本来就有 SIGINT → SIGKILL 的升级
    // (见 instanceSupervisor 的 timeout 分支),单次 stop 产生 2 次 kill 是
    // 设计内行为。这里断言的是「状态不再变化、不会把 stop 掉的实例弄活」。
    const { sup, probeEnteredPromise } = await makeSup(
      '/tmp/zai-wb004-c',
      '/tmp/wb004-cur-c',
      '/tmp/wb004-t-c',
    )
    PROBE_GATE.open = true
    const startPromise = sup.startInstance('i1')
    await probeEnteredPromise
    PROBE_GATE.open = false
    await startPromise
    await new Promise((r) => setTimeout(r, 40))
    expect(spawned[0], '第一次 start 应已 spawn 出 child').toBeDefined()

    await sup.stopInstance('i1')
    await new Promise((r) => setTimeout(r, 40))
    const afterFirst = stateOf(sup, 'i1')
    const killsAfterFirst = ((spawned[0]?.kill as unknown as { mock?: { calls: unknown[][] } })
      ?.mock?.calls.length ?? 0)

    await sup.stopInstance('i1')
    await new Promise((r) => setTimeout(r, 40))
    const killsAfterSecond = ((spawned[0]?.kill as unknown as { mock?: { calls: unknown[][] } })
      ?.mock?.calls.length ?? 0)

    expect(afterFirst, '第一次 stop 后应落到 stopped').toBe('stopped')
    expect(stateOf(sup, 'i1'), '重复 stop 不得改变状态').toBe(afterFirst)
    expect(
      killsAfterSecond,
      '重复 stop 打到已死 child 上 —— 产生了额外 kill',
    ).toBe(killsAfterFirst)
  })
})
