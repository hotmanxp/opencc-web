import path from 'node:path'
import fs from 'node:fs/promises'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  renderGeneratePrompt,
  type TaskListEntry,
} from './prompts/generate.js'
import { renderPickupPrompt } from './prompts/pickup.js'
import { listHandoffs } from './handoff.js'

const HANDON_DIR_PARTS = ['.agent_working_dir', 'handoff']
const RECENT_FOR_LLM = 5 // entries given to the LLM in context
const RECENT_FOR_USER = 3 // entries shown in AskUserQuestion options

function handoffRoot(cwd: string): string {
  return path.join(cwd, ...HANDON_DIR_PARTS)
}

// Format a mtimeMs timestamp as "YYYY-MM-DD HH:MM" in local time.
function formatMtime(mtimeMs: number): string {
  if (!mtimeMs) return '(unknown date)'
  const d = new Date(mtimeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

// Test seam: HANDON_TEST_CWD overrides getOriginalCwd() for unit tests.
// This keeps production behavior unchanged (reads real cwd) while letting
// tests inject a temp dir.
function getCwd(): string {
  const testCwd = process.env.HANDON_TEST_CWD
  if (testCwd) return testCwd
  return getOriginalCwd()
}

const handoff: Command = {
  type: 'prompt',
  name: 'handoff',
  description:
    '交接当前会话：消息多时生成交接文档，消息少时恢复最近的交接',
  argumentHint: '[--pick <filename>]',
  progressMessage: 'preparing handoff',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]> {
    const cwd = getCwd()
    // Count assistant replies. Each assistant message = one complete
    // conversation round. Tool results, slash command invocations, and
    // synthetic user messages are user-type and naturally excluded.
    const N = (context.messages ?? []).filter(m => m.type === 'assistant')
      .length
    const appState = context.getAppState()
    const root = handoffRoot(cwd)
    const today = new Date().toISOString().slice(0, 10)
    const pickArg = /--pick\s+(\S+)/.exec(args)?.[1]

    if (N <= 4) {
      // ---- PICKUP ----
      const rootExists = !!(await fs.stat(root).catch(() => null))
      const all = rootExists ? await listHandoffs(root) : []
      let pickPath: string | null = null
      let pickContent: string | null = null
      let errorNote: string | null = null

      if (pickArg) {
        const candidate = path.join(
          root,
          pickArg.endsWith('.md') ? pickArg : `${pickArg}.md`,
        )
        if (await fs.stat(candidate).catch(() => null)) {
          pickPath = candidate
          pickContent = await fs.readFile(candidate, 'utf8').catch(() => null)
        } else {
          errorNote = `Specified file \`${path.basename(candidate)}\` does not exist`
        }
      } else if (all.length === 0) {
        errorNote = rootExists
          ? `Directory \`${root}\` is empty, no handoff document to resume`
          : `Directory \`${root}\` does not exist`
      }
      // If no --pick and handoffs exist: don't pick one, show the list
      // and let the LLM ask the user via AskUserQuestion.

      // Build the "recent N" listing. Pass only filename + path + mtime to
      // the LLM — do NOT read the handoff content here. The LLM will Read
      // the chosen file with the Read tool after the user picks.
      const topN = await Promise.all(
        all.slice(0, RECENT_FOR_LLM).map(async fullPath => {
          const st = await fs.stat(fullPath).catch(() => null)
          return {
            basename: path.basename(fullPath),
            fullPath,
            mtime: formatMtime(st?.mtimeMs ?? 0),
          }
        }),
      )

      const text = await renderPickupPrompt({
        pickPath,
        pickContent,
        errorNote,
        cwd,
        root,
        recent: topN,
        userOptionCount: RECENT_FOR_USER,
      })
      return [{ type: 'text', text }]
    } else {
      // ---- GENERATE ----
      const taskList: TaskListEntry[] = Object.values(
        (appState.tasks ?? {}) as Record<string, TaskListEntry>,
      ).map(t => ({
        id: t.id,
        type: t.type,
        status: t.status,
        description: t.description,
      }))
      const text = await renderGeneratePrompt({
        cwd,
        root,
        today,
        messageCount: N,
        taskList,
      })
      return [{ type: 'text', text }]
    }
  },
}

export default handoff
