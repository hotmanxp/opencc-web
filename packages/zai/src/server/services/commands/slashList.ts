import { getCommandRegistry } from '@zn-ai/zai-agent-core'
import { listSkills } from '../agentRuntime.js'

export interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string
  argumentHint?: string
  whenToUse?: string
  isBuiltIn?: boolean
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
      ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint } : {}),
      ...(cmd.type === 'prompt' && cmd.whenToUse ? { whenToUse: cmd.whenToUse } : {}),
      isBuiltIn: false,
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
    items.push({
      kind: 'skill',
      name: s.name,
      description: s.description,
    })
  }

  return items
}
