import yaml from 'js-yaml'
import type { LoadedSkill } from '../runtime/skills/types.js'
import type { MCPClientPool } from './MCPClientPool.js'

export type SkillResource = {
  uri: string
  mimeType?: string
  blob?: string
  text?: string
}

export function parseSkillResource(resource: SkillResource, serverName: string): LoadedSkill | null {
  try {
    const raw = resource.text ?? (resource.blob ? Buffer.from(resource.blob, 'base64').toString('utf8') : null)
    if (!raw) return null

    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const fm = yaml.load(match[1]) as Record<string, unknown> | null
    if (!fm || typeof fm.name !== 'string' || typeof fm.description !== 'string') return null

    return {
      name: fm.name,
      description: fm.description,
      body: match[2].trim(),
      source: 'mcp',
      mcpInfo: { serverName, resourceUri: resource.uri },
    }
  } catch {
    return null
  }
}

export async function loadMcpSkills(pool: MCPClientPool, serverName: string): Promise<LoadedSkill[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  try {
    const list = await client.listResources()
    const skills = (list.resources ?? []).filter((r) => r.uri.startsWith('skill://'))
    const results = await Promise.allSettled(
      skills.map((r) => client.readResource({ uri: r.uri }))
    )
    const out: LoadedSkill[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status !== 'fulfilled') continue
      const contents = r.value.contents ?? []
      for (const c of contents) {
        const blob = 'blob' in c ? c.blob : undefined
        const text = 'text' in c ? c.text : undefined
        const skill = parseSkillResource({ uri: skills[i].uri, mimeType: c.mimeType, blob, text }, serverName)
        if (skill) out.push(skill)
      }
    }
    return out
  } catch {
    return []
  }
}
