import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from '../Tool.js'

export type AgentDefinition = {
  name: string
  description: string
  systemPrompt: string
  model?: string
  maxTurns?: number
  additionalTools?: Tool[]
}

export function parseAgentMd(name: string, content: string): AgentDefinition | null {
  const m = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    systemPrompt: m[2]!.trim(),
    model: meta.model,
    maxTurns: meta.maxTurns ? Number(meta.maxTurns) : undefined,
  }
}

export async function loadAgentDefinitions(dataDir: string): Promise<{ agents: AgentDefinition[] }> {
  const dir = join(dataDir, 'agents')
  let entries: string[]
  try { entries = await readdir(dir) } catch { return { agents: [] } }
  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      const content = await readFile(join(dir, entry), 'utf8')
      const parsed = parseAgentMd(entry.replace(/\.md$/, ''), content)
      if (parsed) agents.push(parsed)
    } else {
      try {
        const content = await readFile(join(dir, entry, 'AGENT.md'), 'utf8')
        const parsed = parseAgentMd(entry, content)
        if (parsed) agents.push(parsed)
      } catch { /* skip */ }
    }
  }
  return { agents }
}
