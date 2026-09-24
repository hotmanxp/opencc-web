/**
 * deriveTurnArtifacts —— 从 transcript 的 AgentMessage[] 派生「每一轮改了哪些文件」。
 *
 * 纯函数、无副作用、不读 store —— 数据源就是 useAgentStore.messages,
 * 因此 SSE 实时流与刷新后的历史回放走的是同一条路径,派生结果天然一致。
 * 设计见 docs/superpowers/specs/2026-09-24-zai-turn-artifacts-design.md。
 */
import type { AgentMessage, AgentStatus } from '../../store/useAgentStore.js'

/**
 * 写入类工具白名单 —— 只有这些工具的调用会计入「本轮产物」。
 *
 * 不能用「input 里有 path / file_path 就算」的泛化规则: Read / Grep / Glob
 * 同样带 path 字段,泛化会把只读调用误报成产物。新增写入类工具时在这里加一行。
 */
export const ARTIFACT_WRITE_TOOLS: Readonly<
  Record<string, { label: string; pathKey: string }>
> = {
  Write: { label: '写入', pathKey: 'file_path' },
  Edit: { label: '编辑', pathKey: 'file_path' },
  MultiEdit: { label: '编辑', pathKey: 'file_path' },
  NotebookEdit: { label: '编辑', pathKey: 'notebook_path' },
}

/** 携带工具调用 input 的消息类型 —— start 是首次出现,done/error 是同一 entry 被 tool_result 覆盖后的形态。 */
const TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool_use:start',
  'tool_use:done',
  'tool_use:error',
])

export interface ArtifactFile {
  /** 工具输入里的路径原文,未做规范化 —— 解析交给点击时的 /api/fs/resolve */
  path: string
  /** 展示徽标文案 */
  label: string
  /** 本轮出现次数(UI 在 > 1 时显示 ×N) */
  count: number
  /** 该路径本轮是否出现过 Write —— 驱动徽标配色 */
  written: boolean
}

export interface TurnArtifacts {
  /** 该轮最后一条消息在传入数组中的下标(产物块的锚点) */
  endIndex: number
  /** 该轮首条 user.text 的 eventId —— 用作 React key,保证新消息到达不重置折叠态 */
  turnKey: string
  files: ArtifactFile[]
}

function pathOf(msg: AgentMessage): Omit<ArtifactFile, 'count'> | null {
  if (!TOOL_TYPES.has(String(msg.type))) return null
  const name = (msg as { name?: unknown }).name
  if (typeof name !== 'string') return null
  const spec = ARTIFACT_WRITE_TOOLS[name]
  if (!spec) return null
  const input = (msg as { input?: unknown }).input
  if (input === null || typeof input !== 'object') return null
  const raw = (input as Record<string, unknown>)[spec.pathKey]
  if (typeof raw !== 'string' || raw.length === 0) return null
  return { path: raw, label: spec.label, written: name === 'Write' }
}

export function deriveTurnArtifacts(
  messages: AgentMessage[],
  opts: { status: AgentStatus },
): TurnArtifacts[] {
  const out: TurnArtifacts[] = []
  // 当前轮区间: start 指向该轮首条 user.text 的下标,-1 表示尚未进入任何一轮
  let start = -1
  let turnKey = ''

  const finalize = (end: number, closed: boolean) => {
    // start < 0 → 数组头部是被裁掉的残段,不构成一轮;closed=false → 该轮还在跑
    if (start < 0 || !closed || end < start) return
    const files: ArtifactFile[] = []
    const byPath = new Map<string, ArtifactFile>()
    for (let i = start; i <= end; i++) {
      const hit = pathOf(messages[i]!)
      if (!hit) continue
      const existing = byPath.get(hit.path)
      if (existing) {
        existing.count += 1
        // 该路径本轮只要出现过 Write,徽标就是「写入」(与出现顺序无关)
        if (hit.written) {
          existing.written = true
          existing.label = '写入'
        }
        continue
      }
      const file: ArtifactFile = { ...hit, count: 1 }
      byPath.set(hit.path, file)
      files.push(file)
    }
    if (files.length > 0) out.push({ endIndex: end, turnKey, files })
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (String(m.type) === 'user.text') {
      // 上一轮在 i - 1 结束,且已被新轮顶掉 → 视为已结束
      finalize(i - 1, true)
      start = i
      turnKey = String((m as { eventId?: unknown }).eventId ?? `turn-${i}`)
    }
  }
  // 最后一轮:只有不在流式中才算结束(aborted / error / idle 都算)
  finalize(messages.length - 1, opts.status !== 'streaming')

  return out
}