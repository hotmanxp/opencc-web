import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { TerminalFrame } from '../../../shared/terminal.js'
import { PtySession, TerminalInputTooLargeError, TerminalClosedError, ptyAvailability } from './PtySession.js'
import type { TerminalShell } from '../../../shared/terminal.js'

/**
 * PtySession 的核心验收点（= 本次需求）：**命令之间状态与 CWD 保持**。
 * 用 `sh -i` 而不是 `zsh -i`：测试要快且不依赖用户 rc（oh-my-zsh 启动 1s+）。
 * 提示符用不上（我们没有就绪探测），只按输出内容断言。
 */

const SHELL: TerminalShell =
  process.platform === 'win32'
    ? { path: 'cmd.exe', name: 'cmd', args: [] }
    : { path: '/bin/sh', name: 'sh', args: ['-i'] }

const available = ptyAvailability().available

interface Attached {
  frames: TerminalFrame[]
  output: () => string
  stopped: Promise<void>
  detach: () => void
}

/** 接入一个 follower 并把帧累积下来（用于断言服务端确实推了 snapshot/output/state）。 */
function attach(session: PtySession): Attached {
  const controller = new AbortController()
  const frames: TerminalFrame[] = []
  const stopped = (async () => {
    for await (const frame of session.follow(controller.signal)) frames.push(frame)
  })().catch(() => undefined)
  return {
    frames,
    output: () => frames.filter((f) => f.type === 'output').map((f) => f.data).join(''),
    stopped,
    detach: () => controller.abort(),
  }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for terminal output')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!available)('PtySession — 持久 shell 会话', () => {
  it('起一个真 PTY：follower 先拿 snapshot，再拿 output', async () => {
    const session = new PtySession({ id: 't-1', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const attached = attach(session)
    try {
      await until(() => attached.frames.length > 0)
      expect(attached.frames[0].type).toBe('snapshot')
      expect(session.info.state).toBe('running')
      expect(session.info.shell.name).toBe(SHELL.name)
      expect(session.info.cwd).toBe(tmpdir())
    } finally {
      attached.detach()
      await session.close()
    }
  })

  it('状态与 CWD 跨命令保持（本次改造的核心）', async () => {
    const session = new PtySession({ id: 't-2', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const attached = attach(session)
    try {
      // 等 shell 真正就绪：先要一个确定性的输出再下发断言命令，
      // 否则输入可能落在 rc 文件的读取窗口里。
      session.write('echo READY-ZAI\r')
      await until(() => attached.output().includes('READY-ZAI'))
      const baseline = attached.output().length

      session.write('export ZAI_PTY_VAR=server-test-42\r')
      await new Promise((resolve) => setTimeout(resolve, 200))
      session.write('cd /tmp\r')
      await new Promise((resolve) => setTimeout(resolve, 200))
      session.write('echo "VAR=$ZAI_PTY_VAR PWD=$(pwd)"\r')

      await until(() => attached.output().slice(baseline).includes('VAR=server-test-42 PWD=/tmp'))
      const tail = attached.output().slice(baseline)
      expect(tail).toContain('VAR=server-test-42')
      expect(tail).toContain('PWD=/tmp')
    } finally {
      attached.detach()
      await session.close()
    }
  })

  it('resize 更新 info 并广播 state 帧', async () => {
    const session = new PtySession({ id: 't-3', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const attached = attach(session)
    try {
      await until(() => attached.frames.length > 0)
      session.resize(120, 40)
      await until(() => attached.frames.some((f) => f.type === 'state' && f.info.cols === 120))
      expect(session.info.cols).toBe(120)
      expect(session.info.rows).toBe(40)
    } finally {
      attached.detach()
      await session.close()
    }
  })

  it('rename 只改展示名并广播 state', async () => {
    const session = new PtySession({ id: 't-4', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const attached = attach(session)
    try {
      await until(() => attached.frames.length > 0)
      session.rename('构建日志')
      await until(() => attached.frames.some((f) => f.type === 'state' && f.info.title === '构建日志'))
      expect(session.info.title).toBe('构建日志')
      expect(session.info.shell.name).toBe(SHELL.name)
    } finally {
      attached.detach()
      await session.close()
    }
  })

  it('close 真的杀掉 shell 进程，并把 state 推到 exited', async () => {
    const session = new PtySession({ id: 't-5', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const attached = attach(session)
    const pid = session.info.state === 'running' ? requirePid(session) : 0
    try {
      await until(() => attached.frames.length > 0)
      await session.close()
      expect(session.info.state).toBe('exited')
      // 真有进程死掉的证据：pid 不再存在。
      expect(isAlive(pid)).toBe(false)
      await attached.stopped
    } finally {
      attached.detach()
    }
  })

  it('close 幂等，重复调用不抛', async () => {
    const session = new PtySession({ id: 't-6', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    await session.close()
    await session.close()
    expect(session.info.state).toBe('exited')
  })

  it('超出 maxInputBytes 的输入被拒，已退出的终端写入被拒', async () => {
    const session = new PtySession({ id: 't-7', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    expect(() => session.write('x'.repeat(64 * 1024 + 1))).toThrow(TerminalInputTooLargeError)
    await session.close()
    expect(() => session.write('echo hi\r')).toThrow(TerminalClosedError)
  })

  it('shell 自然退出后，后续 follow 交付快照即结束（不悬挂）', async () => {
    const session = new PtySession({ id: 't-8', shell: SHELL, cwd: tmpdir(), cols: 80, rows: 24 })
    const first = attach(session)
    session.write('echo BYE-ZAI\r')
    await until(() => first.output().includes('BYE-ZAI'))
    session.write('exit\r')
    await until(() => session.info.state === 'exited')
    first.detach()

    const frames: TerminalFrame[] = []
    for await (const frame of session.follow(new AbortController().signal)) frames.push(frame)
    expect(frames[0].type).toBe('snapshot')
    expect(session.info.state).toBe('exited')
  })
})

/** node-pty 的 pid 只在内部持有；这里通过 kill(0) 需要它，故从 pty 句柄取。 */
function requirePid(session: PtySession): number {
  const pty = (session as unknown as { pty: { pid: number } }).pty
  return pty.pid
}