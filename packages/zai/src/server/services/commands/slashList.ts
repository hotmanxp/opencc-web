import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { listSkills } from '../agentRuntime.js'

export interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string
  argumentHint?: string
  whenToUse?: string
  isBuiltIn?: boolean
  isConflict?: boolean
  /** Only set when kind === 'command'. Drives frontend selection behavior. */
  type?: 'local' | 'prompt'
  /**
   * Plugin skill 的展示名（去掉 `plugin:<pluginName>:` 前缀）。
   * 仅 plugin skill 设置，前端用此渲染左列的 `/xxx`。
   * 后端仍然按 `name` 匹配/调用，保证运行时行为不变。
   */
  displayName?: string
  /**
   * Plugin skill 所属的 plugin 名（如 `superpowers`）。
   * 仅 plugin skill 设置，前端把它渲染到描述前缀 `(superpowers)` 中。
   */
  pluginName?: string
}

/**
 * 解析 `plugin:<pluginName>:<rest>` 形式的 skill 名称。
 * 返回 null 表示不是 plugin skill（disk skill），按原样使用 name 即可。
 */
function parsePluginSkillName(rawName: string): { pluginName: string; displayName: string } | null {
  // 例如 `plugin:superpowers:brainstorming` 或 `plugin:superpowers:ns:brainstorming`
  const m = /^plugin:([^:]+):(.+)$/.exec(rawName)
  if (!m) return null
  const pluginName = m[1]!
  // displayName 取最后一个 `:` 之后的真实 skill 名
  const displayName = m[2]!.includes(':') ? m[2]!.split(':').pop()! : m[2]!
  return { pluginName, displayName }
}

export async function slashList(opts: { skills?: Array<{ name: string; description: string }> } = {}): Promise<SlashItem[]> {
  const items: SlashItem[] = []

  // 1. built-in commands first
  for (const cmd of getCommandRegistry().all()) {
    if (cmd.source !== 'builtin') continue
    items.push({
      kind: 'command',
      name: cmd.name,
      description: cmd.description,
      type: cmd.type,
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.type === 'prompt' && cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: true,
    })
  }

  // 2. user commands
  for (const cmd of getCommandRegistry().all()) {
    if (cmd.source !== 'user') continue
    items.push({
      kind: 'command',
      name: cmd.name,
      description: cmd.description,
      type: cmd.type,
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.type === 'prompt' && cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: false,
      ...(cmd.name.startsWith('user:') ? { isConflict: true } : {}),
    })
  }

  // 3. skills (走 service 层 listSkills)
  let skills = opts.skills
  if (!skills) {
    try {
      skills = await listSkills()
    } catch {
      skills = []
    }
  }
  for (const s of skills) {
    const parsed = parsePluginSkillName(s.name)
    if (parsed) {
      items.push({
        kind: 'skill',
        name: s.name,
        description: s.description,
        displayName: parsed.displayName,
        pluginName: parsed.pluginName,
      })
    } else {
      items.push({
        kind: 'skill',
        name: s.name,
        description: s.description,
      })
    }
  }

  return items
}
