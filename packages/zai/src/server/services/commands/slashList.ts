import { getCommandRegistry } from '@zn-ai/zn-agent-core'
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
   * Display name for plugin items (strips the plugin prefix).
   * Set for plugin skills (`plugin:<name>:<skill>` names) and plugin
   * commands (`<pluginName>[:ns]:cmd` names); the frontend renders this
   * in the left `/xxx` column while selection/invocation still match by
   * the full `name`, keeping runtime behavior unchanged.
   */
  displayName?: string
  /**
   * Owning plugin name (e.g. `superpowers`).
   * Set for plugin skills and plugin commands; the frontend renders it as
   * a `(superpowers)` description prefix, aligned with the vendor TUI.
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

/**
 * Resolve `(pluginName, displayName)` for a registry command with
 * `source === 'plugin'`. Plugin command names are shaped
 * `pluginName[:namespace:]command` (vendor loadPluginCommands.ts), so the
 * plugin name comes from the loaded manifest when present (mirroring the
 * vendor `commandSuggestions.ts` pluginNameKey) and falls back to the name
 * prefix. displayName strips the plugin (and namespace) prefix so the
 * dropdown left column shows `/commit` while selection still inserts the
 * full prefixed `/superpowers:commit` name.
 */
function resolvePluginCommandDisplay(cmd: {
  name: string
  pluginInfo?: { pluginManifest?: { name?: string } }
}): { pluginName: string; displayName: string } {
  const pluginName = cmd.pluginInfo?.pluginManifest?.name ?? cmd.name.split(':')[0]!
  const displayName = cmd.name.split(':').pop()!
  return { pluginName, displayName }
}

export async function slashList(
  opts: {
    skills?: Array<{ name: string; description: string; argumentHint?: string }>
  } = {},
): Promise<SlashItem[]> {
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

  // 2b. plugin commands — vendor loads plugin markdown commands with
  // source 'plugin' and name `pluginName[:ns:]command`; emit them with
  // pluginName/displayName so the dropdown shows `(pluginName) description`
  // and searches by plugin name, aligned with the vendor TUI.
  for (const cmd of getCommandRegistry().all()) {
    if (cmd.source !== 'plugin') continue
    const display = resolvePluginCommandDisplay(cmd)
    items.push({
      kind: 'command',
      name: cmd.name,
      description: cmd.description,
      type: cmd.type,
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.type === 'prompt' && cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: false,
      displayName: display.displayName,
      pluginName: display.pluginName,
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
        ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
        displayName: parsed.displayName,
        pluginName: parsed.pluginName,
      })
    } else {
      items.push({
        kind: 'skill',
        name: s.name,
        description: s.description,
        ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
      })
    }
  }

  return items
}
