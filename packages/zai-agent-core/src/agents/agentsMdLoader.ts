import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

export type AgentsMdResult = {
  /** 原始 AGENTS.md 内容（按加载顺序拼接） */
  raw: string
  /** 实际加载的文件列表 */
  files: string[]
}

const AGENTS_FILENAME = 'AGENTS.md'

export type LoadAgentsMdOptions = {
  /** 覆盖 homedir（用于测试） */
  homedirOverride?: string
}

/**
 * 从项目目录和用户目录加载 AGENTS.md 文件。
 *
 * 搜索顺序：
 * 1. {cwd}/AGENTS.md（项目根）
 * 2. {cwd}/.claude/AGENTS.md（项目 .claude 目录）
 * 3. {homedir}/.claude/AGENTS.md（用户全局）
 */
export async function loadAgentsMd(cwd: string, opts?: LoadAgentsMdOptions): Promise<AgentsMdResult> {
  const home = opts?.homedirOverride ?? homedir()
  const candidates = [
    join(cwd, AGENTS_FILENAME),
    join(cwd, '.claude', AGENTS_FILENAME),
    join(home, '.claude', AGENTS_FILENAME),
  ]

  const parts: string[] = []
  const files: string[] = []

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf-8')
      if (content.trim()) {
        parts.push(`<!-- ${filePath} -->\n${content}`)
        files.push(filePath)
      }
    } catch {
      // 文件不存在或不可读，跳过
    }
  }

  return {
    raw: parts.join('\n\n'),
    files,
  }
}

/**
 * 将 AGENTS.md 内容包裹为 system prompt 片段。
 * 如果 AGENTS.md 为空，返回 null。
 */
export function buildAgentsMdSystemPrompt(agentsMd: AgentsMdResult): string | null {
  if (!agentsMd.files.length) return null
  return `以下是根据项目 AGENTS.md 加载的指令：\n\n${agentsMd.raw}`
}