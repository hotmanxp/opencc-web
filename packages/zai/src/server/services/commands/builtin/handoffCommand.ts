import path from 'node:path'
import fs from 'node:fs/promises'
import type { PromptCommand, CommandContext } from '@zn-ai/zn-agent-core'
import { listHandoffs } from '@zn-ai/zn-agent-core'
import { buildGeneratePrompt } from './handoff/prompts/generate.js'
import { buildPickupPrompt, HandoffArgsError } from './handoff/prompts/pickup.js'

export { HandoffArgsError }

export class HandoffCwdError extends Error {}

const PICKUP_THRESHOLD = 4
const HANDOFF_SUBDIR = path.join('.agent_working_dir', 'handoff')

// handoff 仅返回 text block;局部结构类型避免把 anthropic-sdk 类型拖入 zai。
type ContentBlock = { type: 'text'; text: string }

// 真实 CommandContext 是 { cwd, dataDir, sessionId?, model?, messages? }。
// 路由层在 prompt getPromptForCommand 调用前会向 context 注入
// `messages`(由 TranscriptStore.read 读出的 transcript entries)与
// `taskListText`(由 agent state 取值);`messages` 已在 PromptCommand 类型
// 上暴露, `taskListText` 则是 zai 局部扩展 — 这里用 intersection 保留
// 这条 helper 签名,贴近调用现场。
type HandoffContext = CommandContext & {
  taskListText?: string | null
}

interface ParsedArgs {
  pickFile?: string
}

export function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim()
  if (!trimmed) return {}
  const tokens = trimmed.split(/\s+/)
  const out: ParsedArgs = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--pick') {
      const v = tokens[++i]
      if (!v || v.startsWith('--')) {
        throw new HandoffArgsError('用法:/handoff [--pick <​filename>]')
      }
      out.pickFile = v
    } else {
      throw new HandoffArgsError(`未知参数:${t};用法:/handoff [--pick <​filename>]`)
    }
  }
  return out
}

export function resolveCwd(context: HandoffContext): string {
  const cwd = context.cwd
  if (cwd) return cwd
  const fallback = process.cwd()
  if (!fallback) throw new HandoffCwdError('无法解析当前工作目录')
  return fallback
}

/**
 * 与 vendor 一致:从 context.messages 自己数 assistant 消息。
 *
 * 为什么不靠 router 注入 `assistantMessageCount`? 之前 zai 走注入路由,
 * 未注入时 countAssistantMessages fallback 返回 +Infinity,导致 isPickup
 * 永远 false → 永远走 generate。新会话跑 /handoff 拿不到现有交接文档,
 * 转去写新文档就是这个 bug。改为从 context.messages filter 真实轮次。
 *
 * 路由未注入 messages(最早期前端 stub、单测、或没传 sessionId)时,fallback
 * 为 0(对称"新会话")— 与 vendor 把未定义 messages 视作 [] 的行为一致。
 * 0 走 pickup 但 0 文件会触发 pickup prompt 的"未找到"友好提示,引导用户
 * 主动 `/handoff --generate` 走另一边。比 +Infinity fallback 安全得多。
 */
export async function countAssistantMessages(
  context: HandoffContext,
): Promise<number> {
  const messages = context.messages ?? []
  return messages.filter((m) => m.type === 'assistant').length
}

export async function readTaskListText(
  context: HandoffContext,
): Promise<string | null> {
  const injected = context.taskListText
  if (typeof injected === 'string') return injected
  return null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Command definition exported below; getPromptForCommand mirrors OpenCC vendor
// intent: assistant message count <= PICKUP_THRESHOLD → resume existing handoff,
// otherwise generate a new one. --pick overrides the threshold and forces pickup.
export const handoffCommand: PromptCommand = {
  type: 'prompt',
  name: 'handoff',
  description: '交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接',
  argumentHint: '[--pick <​filename>]',
  source: 'builtin',
  progressMessage: 'preparing handoff',
  contentLength: 0,
  async getPromptForCommand(
    args: string,
    context: CommandContext,
  ): Promise<ContentBlock[]> {
    const handoffCtx = context as HandoffContext
    const parsed = parseArgs(args)
    const cwd = resolveCwd(handoffCtx)
    const root = path.join(cwd, HANDOFF_SUBDIR)
    const date = todayISO()
    const assistantCount = await countAssistantMessages(handoffCtx)
    const taskListText = await readTaskListText(handoffCtx)

    const isPickup = parsed.pickFile !== undefined || assistantCount <= PICKUP_THRESHOLD

    if (isPickup) {
      const filePaths = await listHandoffs(root)
      // pickFile 存在性预校验:即便 files=0 也要抛 HandoffArgsError
      // (pickup.ts 的 0-files 分支会短路返回"未找到"提示,不会走到 pickFile 命中判断,
      //  因此在 handler 层显式校验,避免用户传错文件名拿到误导性的"未找到"提示)
      if (parsed.pickFile !== undefined) {
        const matched = filePaths.find(
          (p) => path.basename(p) === parsed.pickFile || p.endsWith(parsed.pickFile!),
        )
        if (!matched) {
          throw new HandoffArgsError(
            `--pick 指定的文件不存在:${parsed.pickFile}\n可选:${filePaths.map((p) => path.basename(p)).join(', ') || '(空)'}`,
          )
        }
      }
      const files: { path: string; mtimeMs: number }[] = await Promise.all(
        filePaths.map(async (p) => {
          try {
            const st = await fs.stat(p)
            return { path: p, mtimeMs: st.mtimeMs }
          } catch {
            return { path: p, mtimeMs: 0 }
          }
        }),
      )
      const text = buildPickupPrompt({
        cwd,
        root,
        date,
        files,
        pickFile: parsed.pickFile,
      })
      return [{ type: 'text', text }]
    }

    const text = buildGeneratePrompt({ cwd, root, date, taskListText })
    return [{ type: 'text', text }]
  },
}
