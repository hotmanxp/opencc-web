/**
 * dsh 会话持久化桥 — B3 T3.1。
 *
 * dsh 轨道用 `dsh-session-persistence-jsonl` 写 `dsh-sessions/<sessionId>/`。
 * `sessions.flush(agent.session)` 每次 turn 结束落盘。
 * `listSessions` / `resumeSession` 从该目录重建 SessionMeta。
 *
 * 与 opencc 轨道不互读 — 数据隔离是 B0-B7 不变量（主计划 §4.2）。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface DshSessionMeta {
  sessionId: string
  cwd: string
  createdAt: number
  /** 事件溯源 log 大小（turn 数）。 */
  turnCount: number
}

/**
 * 列出 dsh 轨道某 cwd 下的所有会话。
 *
 * 数据目录约定：${dataDir}/projects/<cwd>/dsh-sessions/<sessionId>/。
 */
export async function listDshSessions(
  dataDir: string,
  cwd: string,
): Promise<DshSessionMeta[]> {
  const dir = join(dataDir, 'projects', cwd, 'dsh-sessions')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const metas: DshSessionMeta[] = []
  for (const entry of entries) {
    const sessionDir = join(dir, entry)
    try {
      const s = await stat(sessionDir)
      if (!s.isDirectory()) continue
      metas.push({
        sessionId: entry,
        cwd,
        createdAt: s.birthtimeMs,
        turnCount: 0, // 由读取 SessionHeader 填充（B3 T3.2 完整对齐）
      })
    } catch {
      // 跳过不可读目录
    }
  }
  return metas
}

/**
 * 读取 dsh 会话 Header（B3 T3.2）。
 *
 * Header 是 SessionEvent 之外的 metadata（B0 创建时填），包含 createdAt/cwd/
 * parentSession/seedLength/origin/delegationDepth/agentPreset。
 *
 * 当前为 stub：实际读 session.log 第一行（dsh-session-persistence-jsonl 格式）。
 */
export async function readDshSessionHeader(
  _dataDir: string,
  _cwd: string,
  _sessionId: string,
): Promise<unknown> {
  return null
}