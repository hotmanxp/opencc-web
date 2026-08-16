import path from 'node:path'
import type { PromptCommand, CommandContext } from '@zn-ai/zn-agent-core'
import type { ContentBlockParam } from '@zn-ai/zn-agent-core'
import {
  listHandoffs,
  getLatestHandoff,
  buildHandoffPath,
} from '@zn-ai/zn-agent-core'
import { buildGeneratePrompt } from './handoff/prompts/generate.js'
import { buildPickupPrompt, HandoffArgsError } from './handoff/prompts/pickup.js'

export { HandoffArgsError }

export class HandoffCwdError extends Error {}

const PICKUP_THRESHOLD = 4
const HANDOFF_SUBDIR = path.join('.agent_working_dir', 'handoff')

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
        throw new HandoffArgsError('用法:/handoff [--pick <filename>]')
      }
      out.pickFile = v
    } else {
      throw new HandoffArgsError(`未知参数:${t};用法:/handoff [--pick <filename>]`)
    }
  }
  return out
}

export function resolveCwd(context: CommandContext | null | undefined): string {
  const cwd = (context as { cwd?: string } | null | undefined)?.cwd
  if (cwd) return cwd
  const fallback = process.cwd()
  if (!fallback) throw new HandoffCwdError('无法解析当前工作目录')
  return fallback
}

export async function countAssistantMessages(
  context: CommandContext | null | undefined,
): Promise<number> {
  const injected = (context as { assistantMessageCount?: unknown } | null | undefined)
    ?.assistantMessageCount
  if (typeof injected === 'number') return injected
  return Number.POSITIVE_INFINITY
}

export async function readTaskListText(
  context: CommandContext | null | undefined,
): Promise<string | null> {
  const injected = (context as { taskListText?: unknown } | null | undefined)?.taskListText
  if (typeof injected === 'string') return injected
  return null
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Command definition exported below; getPromptForCommand body added in Step 5.
export const handoffCommand: PromptCommand = {
  type: 'prompt',
  name: 'handoff',
  description: '交接当前会话:消息多时生成交接文档,消息少时恢复最近的交接',
  argumentHint: '[--pick <filename>]',
  source: 'builtin',
  progressMessage: 'preparing handoff',
  contentLength: 0,
  isEnabled: () => true,
  async getPromptForCommand(args: string, context: CommandContext): Promise<ContentBlockParam[]> {
    const parsed = parseArgs(args)
    const cwd = resolveCwd(context)
    const root = path.join(cwd, HANDOFF_SUBDIR)
    const date = todayISO()
    const assistantCount = await countAssistantMessages(context)
    const taskListText = await readTaskListText(context)

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
            const st = await import('node:fs/promises').then((m) => m.stat(p))
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