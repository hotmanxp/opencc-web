import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBuiltinMainAgents } from '../../src/opencc-src/server/mainAgents.js'
import {
  BUILTIN_MAIN_AGENT_NAMES,
  validateMainAgentFile,
  agentCreatorMainAgent,
} from '../../src/opencc-src/server/mainAgents-agentCreator.js'

describe('BUILTIN_MAIN_AGENT_NAMES stays in sync with builtins (2026-09-03)', () => {
  it('Set equals getBuiltinMainAgents() names', () => {
    const actual = new Set(getBuiltinMainAgents().map((a) => a.name))
    expect([...BUILTIN_MAIN_AGENT_NAMES].sort()).toEqual([...actual].sort())
  })

  it('agent-creator prompt embeds the full (interpolated) builtin list, not a stale hand-written one', async () => {
    const resolved = await agentCreatorMainAgent.systemPrompt!(['x'])
    const text = resolved.join('\n')
    for (const name of BUILTIN_MAIN_AGENT_NAMES) {
      expect(text).toContain(name)
    }
  })

  it('validateMainAgentFile warns when an external file collides with task-intake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'main-agents-'))
    const file = join(dir, 'collision.js')
    await writeFile(
      file,
      `module.exports = { name: 'task-intake', description: 'override' };`,
      'utf-8',
    )
    const result = await validateMainAgentFile(file)
    expect(result.ok).toBe(true)
    const intake = result.agents.find((a) => a.name === 'task-intake')
    expect(intake?.warnings.some((w) => w.includes('覆盖内置'))).toBe(true)
  })
})
