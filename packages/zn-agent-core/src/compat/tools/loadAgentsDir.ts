// @zn-ai/zn-agent-core compat shim — port of zai-agent-core tools/AgentTool/loadAgentsDir.ts.
//
// Path adjustments:
//   - `import type { Tool } from '../Tool.js'` → use the new compat Tool shape
//     from `../runtime/types.js` (cross-package compat — the new package's
//     Tool widens `description: string | Function` so the legacy Tool shape
//     from old `Tool.ts` still type-checks structurally).
//   - `import { BUILT_IN_AGENTS } from './builtInAgents.js'` — see TODO below.
//     Old built-in agents are not yet ported; we declare a stub `BUILT_IN_AGENTS`
//     here so `loadAgentDefinitions` still runs (returning an empty built-in set).
//
// TODO: port the original `builtInAgents.ts` content into `compat/tools/builtInAgents.ts`
//       so the built-in agents (general-purpose, statusline-setup, Explore, Plan, etc.)
//       actually surface. Today's zai-server wires its own `BUILT_IN_AGENTS` array
//       directly, so the empty default doesn't break anything in practice — but a
//       complete port needs the real list.

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../runtime/types.js'

// Stub — see TODO above. The legacy `builtInAgents.ts` content lands in a
// follow-up commit; until then, no built-in agents are loaded.
const BUILT_IN_AGENTS: AgentDefinition[] = []

export type AgentDefinition = {
  name: string
  description: string
  systemPrompt: string
  model?: string
  maxTurns?: number
  additionalTools?: Tool[]
  /**
   * Tool names this agent must NOT be granted. Currently informational —
   * queryEngine does not enforce it. Wired in a follow-up iteration to
   * align with opencc's `ALL_AGENT_DISALLOWED_TOOLS` /
   * `CUSTOM_AGENT_DISALLOWED_TOOLS` semantics.
   */
  forbiddenTools?: string[]
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
    // Comma-separated list in frontmatter → string[]. Empty/undefined omitted.
    forbiddenTools: meta.forbiddenTools
      ? meta.forbiddenTools.split(',').map(s => s.trim()).filter(Boolean)
      : undefined,
  }
}

async function loadFromDir(dirPath: string): Promise<AgentDefinition[]> {
  let entries: string[]
  try {
    entries = await readdir(dirPath)
  } catch {
    return []
  }
  const out: AgentDefinition[] = []
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      const content = await readFile(join(dirPath, entry), 'utf8')
      const parsed = parseAgentMd(entry.replace(/\.md$/, ''), content)
      if (parsed) out.push(parsed)
    } else {
      try {
        const content = await readFile(join(dirPath, entry, 'AGENT.md'), 'utf8')
        const parsed = parseAgentMd(entry, content)
        if (parsed) out.push(parsed)
      } catch { /* skip — not an agent dir */ }
    }
  }
  return out
}

/**
 * Load agent definitions from three sources, merged by name with last-wins
 * (REPLACE, not merge of fields).
 *
 *   built-in  <  project (<dataDir>/agents)  <  user-global (~/.zai/agents)
 *
 * The built-in set is always present, even when both file-based sources
 * are empty or missing. Pass `userAgentsDir: ''` to disable user-global
 * loading entirely (e.g. in tests or sandboxed environments).
 *
 * `homedirOverride` exists for testability — it lets tests point the
 * `~/.zai/agents` resolution at a tmp dir without mutating process.env.
 */
export async function loadAgentDefinitions(
  dataDir: string,
  userAgentsDir?: string,
  homedirOverride?: string,
  pluginAgents: AgentDefinition[] = [],
): Promise<{ agents: AgentDefinition[] }> {
  const projectDir = join(dataDir, 'agents')
  const fromProject = await loadFromDir(projectDir)

  let fromUser: AgentDefinition[] = []
  if (userAgentsDir !== '') {
    const userDir = userAgentsDir
      ?? join(homedirOverride ?? homedir(), '.zai', 'agents')
    fromUser = await loadFromDir(userDir)
  }

  // Built-in → project → user-global. Map keyed by name, later writes win.
  const byName = new Map<string, AgentDefinition>()
  for (const a of BUILT_IN_AGENTS) byName.set(a.name, a)
  for (const a of fromProject) byName.set(a.name, a)
  for (const a of fromUser) byName.set(a.name, a)
  for (const a of pluginAgents) byName.set(a.name, a)
  return { agents: Array.from(byName.values()) }
}