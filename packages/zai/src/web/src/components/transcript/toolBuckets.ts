// toolBuckets.ts — 工具调用的「分类计数」文案层.
//
// 模型沿用 TraeCode 的 exploreGroup 分类法(扒自
// /Applications/Trae CN.app → @byted-icube/ai-modules-chat 的 i18n 表,
// key 形如 trae-chat-core.exploreGroup.runCommand.completed = "执行 {count} 条命令"):
// 一段连续工具调用折叠成一行摘要时, 不按工具名罗列, 而是按「干了一类什么事」
// 聚合计数, 逗号连接 —— "已执行 2 条命令，已更新待办"。
//
// 这里只做纯函数: 工具名 → 分类 → 文案。不含任何 React, 便于单测。
import { getRenderer } from '../toolRenderers/registry.js'
import type { ToolGroupEntry } from './deriveTranscriptNodes.js'

export type ToolBucket =
  | 'runCommand'
  | 'fileView'
  | 'fileSearch'
  | 'fileEdit'
  | 'fileCreate'
  | 'folderView'
  | 'taskManagement'
  | 'skill'
  | 'mcpCall'
  | 'other'

// 显式映射; 未列出的工具名落到 other。MCP 工具名 (mcp_<server>_<action>)
// 是动态注入的, 走前缀判断而非占坑。
const BUCKET_BY_TOOL: Readonly<Record<string, ToolBucket>> = {
  Bash: 'runCommand',
  Read: 'fileView',
  Glob: 'fileSearch',
  Grep: 'fileSearch',
  Edit: 'fileEdit',
  MultiEdit: 'fileEdit',
  NotebookEdit: 'fileEdit',
  Write: 'fileCreate',
  TaskCreate: 'taskManagement',
  TaskUpdate: 'taskManagement',
  TaskList: 'taskManagement',
  TodoWrite: 'taskManagement',
  Skill: 'skill',
}

export function bucketOf(name: string | undefined): ToolBucket {
  const n = (name ?? '').trim()
  if (!n) return 'other'
  const hit = BUCKET_BY_TOOL[n]
  if (hit) return hit
  if (n.startsWith('mcp_')) return 'mcpCall'
  return 'other'
}

type BucketMeta = {
  /** 折叠摘要:该类已全部完成 */
  done: (n: number) => string
  /** 折叠摘要:该类还有在跑的 */
  running: string
  /** 展开态单行:该条已完成 */
  verb: string
  /** 图标徽章配色 (CSS var, 走 index.css 的主题 token) */
  tint: string
}

const BUCKET_META: Readonly<Record<ToolBucket, BucketMeta>> = {
  runCommand: {
    done: (n) => `已执行 ${n} 条命令`,
    running: '正在执行命令',
    verb: '命令已执行',
    tint: 'var(--tool-tint-command, #f97316)',
  },
  fileView: {
    done: (n) => `已读取 ${n} 个文件`,
    running: '正在读取文件',
    verb: '已读取文件',
    tint: 'var(--tool-tint-view, #38bdf8)',
  },
  fileSearch: {
    done: (n) => `已搜索 ${n} 次文件`,
    running: '正在搜索文件',
    verb: '已搜索文件',
    tint: 'var(--tool-tint-search, #a78bfa)',
  },
  fileEdit: {
    done: (n) => `已编辑 ${n} 个文件`,
    running: '正在编辑文件',
    verb: '已编辑文件',
    tint: 'var(--tool-tint-edit, #4ade80)',
  },
  fileCreate: {
    done: (n) => `已创建 ${n} 个文件`,
    running: '正在创建文件',
    verb: '已创建文件',
    tint: 'var(--tool-tint-edit, #4ade80)',
  },
  folderView: {
    done: (n) => `已浏览 ${n} 个目录`,
    running: '正在浏览目录',
    verb: '已浏览目录',
    tint: 'var(--tool-tint-view, #38bdf8)',
  },
  taskManagement: {
    // 待办更新没有"次数"语义, 固定文案不带计数 (对齐 Trae 的 taskManagement)
    done: () => '已更新待办',
    running: '正在更新待办',
    verb: '已更新待办',
    tint: 'var(--tool-tint-todo, #fbbf24)',
  },
  skill: {
    done: (n) => `已调用 ${n} 次技能`,
    running: '正在调用技能',
    verb: '已调用技能',
    tint: 'var(--tool-tint-skill, #f472b6)',
  },
  mcpCall: {
    done: (n) => `已调用 ${n} 次 MCP`,
    running: '正在调用 MCP',
    verb: '已调用 MCP',
    tint: 'var(--tool-tint-mcp, #22d3ee)',
  },
  other: {
    done: (n) => `已调用 ${n} 次工具`,
    running: '正在调用工具',
    verb: '已调用工具',
    tint: 'var(--tool-tint-other, #94a3b8)',
  },
}

export function bucketMeta(bucket: ToolBucket): BucketMeta {
  return BUCKET_META[bucket]
}

function isPending(entry: ToolGroupEntry): boolean {
  return entry.status === 'pending'
}

function isFailed(entry: ToolGroupEntry): boolean {
  return entry.status === 'error' || entry.status === 'invalid' || entry.status === 'denied'
}

export type RunSummary = {
  /** 逗号连接的摘要文案, 例: "已执行 2 条命令，已更新待办" */
  text: string
  /** 该段是否还有工具在跑 */
  active: boolean
  /** 失败 / 拒绝 / 非法 的条数 */
  errors: number
  /** 段内出现的分类(按首次出现顺序), 用于取摘要行的图标 */
  buckets: ToolBucket[]
}

/**
 * 把一段连续工具调用折叠成一行摘要。
 *
 * 分类顺序按「段内首次出现顺序」而非固定枚举序 —— 一段里通常只有 1-2 类,
 * 先出现的那类就是用户最先看到的动作, 应该排在前面。
 */
export function summarizeRun(entries: ToolGroupEntry[]): RunSummary {
  const counts = new Map<ToolBucket, { total: number; pending: number }>()
  let errors = 0
  for (const e of entries) {
    const b = bucketOf((e.message as { name?: string }).name)
    const cur = counts.get(b) ?? { total: 0, pending: 0 }
    cur.total += 1
    if (isPending(e)) cur.pending += 1
    counts.set(b, cur)
    if (isFailed(e)) errors += 1
  }

  const active = entries.some(isPending)
  const parts: string[] = []
  for (const [b, c] of counts) {
    const meta = BUCKET_META[b]
    // 有在跑的: 显示 running 文案 (不计已完成数, running 期间数字会跳)
    parts.push(c.pending > 0 ? meta.running : meta.done(c.total))
  }

  return {
    text: parts.join('，'),
    active,
    errors,
    buckets: [...counts.keys()],
  }
}

export type ToolRow = {
  bucket: ToolBucket
  /** 单行文案, 例: "命令已执行" / "正在读取文件" */
  label: string
  /** 折叠态右侧的预览 (路径 / 命令 / pattern), 可为空 */
  detail: string
  failed: boolean
  pending: boolean
}

/**
 * 单条工具调用的行描述。detail 复用 renderer.preview —— 每个工具已有
 * 自己的辨识策略 (Bash→description/command, Read→file_path, Glob/Grep→
 * `pattern in path`), 不在这里另造一套。
 */
export function describeTool(entry: ToolGroupEntry): ToolRow {
  const msg = entry.message as {
    name?: string
    input?: Record<string, unknown>
  }
  const name = msg.name ?? ''
  const bucket = bucketOf(name)
  const meta = BUCKET_META[bucket]
  const pending = isPending(entry)
  let detail = ''
  try {
    detail = getRenderer(name).preview(msg.input ?? {}) ?? ''
  } catch {
    // preview 是纯展示逻辑, 但 renderer 可能被 setRenderer 换成用户自定义实现;
    // preview 抛错不应该让整段工具摘要消失。
    detail = ''
  }
  return {
    bucket,
    label: pending ? meta.running : meta.verb,
    detail,
    failed: isFailed(entry),
    pending,
  }
}