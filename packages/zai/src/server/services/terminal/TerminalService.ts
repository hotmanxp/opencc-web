import {
  TERMINAL_LIMITS,
  type CreateTerminalRequest,
  type TerminalEnvironment,
  type TerminalShell,
  type WebTerminalInfo,
} from '../../../shared/terminal.js'
import { discoverShells, resolveDefaultShell, resolveShellPath } from './shells.js'
import {
  PtySession,
  TerminalClosedError,
  TerminalNotFoundError,
  TerminalShellUnavailableError,
  ptyAvailability,
} from './PtySession.js'

/**
 * 每会话持有的用户终端注册中心。
 * 移植自 deepseek-harness `packages/api/terminal-controller/src/index.ts` 的
 * `TerminalController`，裁掉 Agent/sandbox 语义与 retain 引用计数。
 */

interface Owner {
  readonly terminals: Map<string, PtySession>
  /** 已关闭的身份：不允许用同一个 id 复活（create 会被拒 409）。 */
  readonly closedIds: Set<string>
}

function maxTerminalsMessage(): string {
  return `最多同时保留 ${TERMINAL_LIMITS.maxTerminals} 个终端，请先关闭一个再新建`
}

export class TerminalService {
  private readonly owners = new Map<string, Owner>()
  private disposed = false

  /** 新建终端前的能力与上限（前端据此夹取尺寸、决定是否禁用 UI）。 */
  environment(cwd: string): TerminalEnvironment {
    const availability = ptyAvailability()
    return {
      cwd,
      ...availability,
      maxCols: TERMINAL_LIMITS.maxCols,
      maxRows: TERMINAL_LIMITS.maxRows,
      maxInputBytes: TERMINAL_LIMITS.maxInputBytes,
      maxTerminals: TERMINAL_LIMITS.maxTerminals,
      scrollback: TERMINAL_LIMITS.scrollback,
    }
  }

  /** 本机已安装的 shell，默认 shell 排第一。 */
  shells(): TerminalShell[] {
    return discoverShells()
  }

  /** 该会话保留的终端（含已退出的），用于刷新后重建 tab。 */
  list(sessionId: string): WebTerminalInfo[] {
    const owner = this.owners.get(sessionId)
    if (!owner) return []
    return [...owner.terminals.values()].map((session) => session.info)
  }

  /**
   * 为给定 id 分配一个持久 PTY；同一 id 重复调用是幂等的（返回既有终端）。
   * @throws TerminalClosedError - 服务正在关闭 / id 已关闭 / 超出上限
   * @throws TerminalShellUnavailableError - 指定或默认 shell 在本机不存在
   */
  create(request: CreateTerminalRequest): WebTerminalInfo {
    if (this.disposed) throw new TerminalClosedError('terminal service is shutting down')
    const owner = this.owner(request.sessionId)
    const existing = owner.terminals.get(request.id)
    if (existing) return existing.info
    if (owner.closedIds.has(request.id)) {
      throw new TerminalClosedError(`terminal was already closed: ${request.id}`)
    }
    if (owner.terminals.size >= TERMINAL_LIMITS.maxTerminals) {
      throw new TerminalClosedError(maxTerminalsMessage())
    }
    const shell = request.shellPath ? resolveShellPath(request.shellPath) : resolveDefaultShell()
    if (shell === undefined) {
      throw new TerminalShellUnavailableError(request.shellPath ?? '(系统默认 shell)')
    }
    const session = new PtySession({
      id: request.id,
      shell,
      cwd: request.cwd ?? process.cwd(),
      cols: request.cols,
      rows: request.rows,
    })
    owner.terminals.set(request.id, session)
    return session.info
  }

  /** 取出一个终端实例（SSE 路由 attach 用）。 */
  get(sessionId: string, id: string): PtySession {
    const session = this.owners.get(sessionId)?.terminals.get(id)
    if (session === undefined) throw new TerminalNotFoundError(id)
    return session
  }

  write(sessionId: string, id: string, data: string): void {
    this.get(sessionId, id).write(data)
  }

  resize(sessionId: string, id: string, cols: number, rows: number): Promise<void> {
    return this.get(sessionId, id).resize(cols, rows)
  }

  rename(sessionId: string, id: string, title: string): void {
    this.get(sessionId, id).rename(title)
  }

  /**
   * 关闭身份并杀掉进程；重复 close 成功（幂等）。
   * @throws TerminalNotFoundError - 该 id 从未存在
   */
  async close(sessionId: string, id: string): Promise<void> {
    const owner = this.owners.get(sessionId)
    const session = owner?.terminals.get(id)
    if (session === undefined) {
      if (owner?.closedIds.has(id)) return
      throw new TerminalNotFoundError(id)
    }
    owner?.closedIds.add(id)
    owner?.terminals.delete(id)
    await session.close()
  }

  /** 会话销毁时回收它的全部终端（进程必须真的死掉，否则会留一堆 shell）。 */
  async disposeSession(sessionId: string): Promise<void> {
    const owner = this.owners.get(sessionId)
    if (owner === undefined) return
    this.owners.delete(sessionId)
    const sessions = [...owner.terminals.values()]
    owner.terminals.clear()
    await Promise.allSettled(sessions.map((session) => session.close()))
  }

  /** 进程退出前的全局收尾。 */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.owners.keys()].map((sessionId) => this.disposeSession(sessionId)))
  }

  private owner(sessionId: string): Owner {
    let owner = this.owners.get(sessionId)
    if (owner === undefined) {
      owner = { terminals: new Map(), closedIds: new Set() }
      this.owners.set(sessionId, owner)
    }
    return owner
  }
}

let singleton: TerminalService | null = null

export function getTerminalService(): TerminalService {
  if (!singleton) singleton = new TerminalService()
  return singleton
}

/** 测试 seam：丢掉单例并关闭它持有的全部 PTY。 */
export async function __resetTerminalServiceForTest(): Promise<void> {
  if (!singleton) return
  const service = singleton
  singleton = null
  await service.disposeAll()
}