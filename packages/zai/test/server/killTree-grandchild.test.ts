/**
 * 回归测试 — 杀 sh -c 时必须连它的子进程一起杀 (cc-005)。
 *
 * 缺陷:`killTree.ts` 的非 win32 分支只有 `child.kill()`,信号发给 `sh -c`
 * 包装层本身。命令体(它的子进程)在 sh 退出后存活 —— 移动端快捷 Bash /
 * 命令历史正是这个形态(`sh -c` + piped stdio,非 PTY)。
 *
 * 对照既有测试 `replRegistry-subprocess.test.ts`:那条只断言**直接子进程**
 * (`session.child.pid` 即 sh 本身)消失,而 sh 本来就会被 SIGTERM 杀掉 ——
 * 它测不到 sh 的子进程。本文件测的就是这一层。
 *
 * ── 复现形态的选择(实测,不是推测)────────────────────────────────────
 * 简单命令走不通:macOS 的 sh 对 `sh -c 'sleep 300'` 做 **exec 优化** ——
 * sh 直接被替换成 sleep,根本不存在「包装层 + 子进程」两层,自然也没有孤儿。
 * 只有让 sh **必须 fork 子进程**的形态才会留下存活进程:
 *   - `{ sleep 300; }`      花括号组
 *   - `sh -c "sleep 300" & wait`  嵌套
 * 实测数据(修复前,detached:false):
 *   sh pid=33494 pgid=33480  →  **pgid ≠ sh pid**,sh 不是进程组组长
 *   `process.kill(-shpid)`   →  **ESRCH**(负 pid 不是任何进程组)
 *   SIGTERM sh 之后 sleep 33495 **仍然存活**
 * 修法:`spawn` 加 `detached: true` 让 sh 成为组长,再 `process.kill(-pid)`。
 * 实测(修复后,detached:true):
 *   sh pid=33507 pgid=33507(组长)→ kill(-pid) 成功 → 子进程全灭
 * ────────────────────────────────────────────────────────────────────
 *
 * ⚠️ detached 的副作用(计划书标为「必查」):子进程脱离控制终端,不再因终端
 * 关闭收到 SIGHUP。所以必须确认回收路径仍覆盖本场景 —— 第三例走
 * ReplRegistry.disposeAll(),正是 runtimeLifecycle 退出时调的那个。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { getReplRegistry, __resetReplRegistryForTest } from '../../src/server/services/repl/ReplRegistry.js'

/** sh 会 fork 出子进程的形态(避开 macOS 的 exec 优化)。 */
const FORKING_CMD = '{ sleep 300; }'

function psRows(): Array<{ pid: number; ppid: number; pgid: number; comm: string }> {
  try {
    return execSync('ps -axo pid=,ppid=,pgid=,comm=', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
        return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], comm: m[4] } : null
      })
      .filter((r): r is { pid: number; ppid: number; pgid: number; comm: string } => r !== null)
  } catch {
    return []
  }
}

function inPs(pid: number): boolean {
  return psRows().some((r) => r.pid === pid)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** sh 当前的直接子进程(即命令体)。 */
function childrenOf(pid: number): number[] {
  return psRows().filter((r) => r.ppid === pid).map((r) => r.pid)
}

/** 等 pid 从 ps 里彻底消失(含 zombie)。 */
async function waitGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!inPs(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !inPs(pid)
}

async function cleanup(pid: number) {
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

describe('killChildTree — 必须连 sh 的子进程一起杀 (cc-005)', () => {
  afterEach(() => __resetReplRegistryForTest())

  it('sh -c 的命令体不得在 abort() 后存活', async () => {
    const reg = getReplRegistry()
    const sid = 'cc005-abort'
    const session = reg.get(sid, process.cwd())

    await session.exec(FORKING_CMD, sid)
    const shPid = (session as unknown as { child?: { pid?: number } }).child?.pid
    expect(shPid, 'session 应已 spawn 出子进程').toBeTypeOf('number')

    await new Promise((r) => setTimeout(r, 400))
    const kids = childrenOf(shPid!)
    expect(kids.length, 'sh 应 fork 出命令体 —— 若为 0 说明 exec 优化吃掉了包装层').toBeGreaterThan(0)

    // 单条命令结束路径(移动端快捷 Bash 的 abort 按钮)
    session.abort()
    await new Promise((r) => setTimeout(r, 700))

    for (const pid of kids) {
      const gone = await waitGone(pid, 2000)
      expect(gone, `命令体 ${pid} 在 abort() 后仍存活 —— killTree 只把信号发给了 sh 包装层`).toBe(true)
    }
    await cleanup(shPid!)
  })

  it('disposeAll 路径同样带走命令体(进程退出场景)', async () => {
    const reg = getReplRegistry()
    const sid = 'cc005-dispose'
    const session = reg.get(sid, process.cwd())

    await session.exec(FORKING_CMD, sid)
    const shPid = (session as unknown as { child?: { pid?: number } }).child?.pid
    await new Promise((r) => setTimeout(r, 400))

    const kids = childrenOf(shPid!)
    expect(kids.length).toBeGreaterThan(0)

    // 这正是 runtimeLifecycle closeServer() 里调的那个
    reg.disposeAll()
    await new Promise((r) => setTimeout(r, 700))

    for (const pid of kids) {
      expect(await waitGone(pid, 2000), `退出路径留下孤儿 ${pid}`).toBe(true)
    }
  })

  it('直接子进程(sh 自身)仍被杀掉 —— 不得因改 kill(-pid) 而回归', async () => {
    const reg = getReplRegistry()
    const sid = 'cc005-direct'
    const session = reg.get(sid, process.cwd())

    await session.exec('sleep 300', sid)
    const shPid = (session as unknown as { child?: { pid?: number } }).child?.pid
    expect(shPid).toBeTypeOf('number')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(shPid!)).toBe(true)

    reg.disposeAll()
    await new Promise((r) => setTimeout(r, 600))
    expect(alive(shPid!), '直接子进程也应消失').toBe(false)
  })
})
