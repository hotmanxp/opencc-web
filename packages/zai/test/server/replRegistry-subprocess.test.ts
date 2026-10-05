/**
 * M3 真实验证 —— ReplRegistry 回收的子进程真的消失了吗？
 * (bug `repl-registry-child-process-leak`)
 *
 * 单元测试只能断言 map 空了;计划书 §「验证」要求的是「起一个 sleep 300,
 * 调 closeServer(),断言子进程已消失（ps）」。这里补上这一层。
 *
 * 关键背景:`sh -c` + piped stdio 的子进程是**普通同进程组进程**,父进程
 * 干净 exit(0) 时收不到任何信号,会被 init 收养继续存活。managed child 以
 * detached:false spawn 按 pid kill,supervisor 驱动的重启也扫不到这些孙进程。
 * 对比 PTY 路径(node-pty/forkpty)反而安全 —— 内核会发 SIGHUP。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { getReplRegistry, __resetReplRegistryForTest } from '../../src/server/services/repl/ReplRegistry.js'

/** pid 是否还活着。signal 0 不发信号,只探活。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** ps 里还能不能看到这个 pid —— 比 process.kill 更严格(zombie 也算残留)。 */
function inPs(pid: number): boolean {
  try {
    execSync(`ps -p ${pid} -o pid=`, { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

describe('ReplRegistry.disposeAll —— 子进程真的被回收', () => {
  afterEach(() => __resetReplRegistryForTest())

  it('disposeAll 杀掉 session 持有的 sh -c 子进程', async () => {
    const reg = getReplRegistry()
    const sid = 'm3-proc-test'
    const session = reg.get(sid, process.cwd())

    // 经真实 exec 路径起一个长命令:sh -c 'sleep 300'。
    // 这正是移动端快捷 Bash 用的形态(非 PTY)。
    await session.exec('sleep 300', sid)
    const childPid = (session as unknown as { child?: { pid?: number } }).child?.pid
    expect(childPid, 'session 应已 spawn 出子进程').toBeTypeOf('number')

    // 给它一点时间真正起来
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(childPid!)).toBe(true)
    expect(inPs(childPid!)).toBe(true)

    // 关键动作:进程退出路径上会调的就是这个
    reg.disposeAll()

    // killChildTree 是异步发信号,给一点时间落地
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(childPid!), 'disposeAll 后子进程应已消失').toBe(false)
    expect(inPs(childPid!), 'ps 里不应再有该 pid').toBe(false)
  })
})
