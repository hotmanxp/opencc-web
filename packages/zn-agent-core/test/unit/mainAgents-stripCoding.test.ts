import { describe, expect, it } from 'vitest'
import { stripCodingSections } from '../../src/opencc-src/server/mainAgents-promptSections.js'
import { officeMainAgent } from '../../src/opencc-src/server/mainAgents-office.js'
import { agentCreatorMainAgent } from '../../src/opencc-src/server/mainAgents-agentCreator.js'
import { taskFactoryMainAgent } from '../../src/opencc-src/server/mainAgents-taskFactory.js'
import { taskIntakeMainAgent } from '../../src/opencc-src/server/mainAgents-taskIntake.js'

// Mirror of constants/prompts.ts SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Kept as a
// literal so the test doesn't pull the heavy prompts.js module graph
// (which loads BashTool and trips getMaxTimeoutMs in the unit env).
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

/** A representative slice of the real getSystemPrompt() output array. */
function fakeOrigin(): string[] {
  return [
    '\nYou are an interactive agent that helps users with software engineering tasks. Use the instructions below',
    '# System\nAll text you output outside of tool use is displayed to the user.',
    '# Doing tasks\n- The user will primarily request you to perform software engineering tasks.',
    '# Executing actions with care\nCarefully consider the reversibility and blast radius of actions.',
    '# Using your tools\n- To read files use Read instead of cat',
    '# Tone and style\n- Only use emojis if the user explicitly requests it.',
    '# Output efficiency\nGo straight to the point.',
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    '# CodeGraph\nThis project is indexed by CodeGraph',
    'Session ticket id: `ABC#123`. Prefix all git commits with it.',
    '# Language\nAlways respond in 中文.',
  ]
}

const CODING_SECTIONS = [
  'You are an interactive agent',
  '# Doing tasks',
  '# CodeGraph',
  'Session ticket id:',
]

describe('stripCodingSections (2026-09-03)', () => {
  it('removes coding-only sections, keeps general ones + boundary marker', () => {
    const out = stripCodingSections(fakeOrigin())
    // coding sections gone
    for (const prefix of CODING_SECTIONS) {
      expect(out.some((s) => s.trim().startsWith(prefix))).toBe(false)
    }
    // general sections kept
    expect(out.some((s) => s.startsWith('# System'))).toBe(true)
    expect(out.some((s) => s.startsWith('# Executing actions with care'))).toBe(true)
    expect(out.some((s) => s.startsWith('# Using your tools'))).toBe(true)
    expect(out.some((s) => s.startsWith('# Tone and style'))).toBe(true)
    expect(out.some((s) => s.startsWith('# Output efficiency'))).toBe(true)
    expect(out.some((s) => s.startsWith('# Language'))).toBe(true)
  })

  it('preserves the dynamic cache boundary marker exactly once', () => {
    const out = stripCodingSections(fakeOrigin())
    expect(out.filter((s) => s === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toHaveLength(1)
  })

  it('keep: ["codegraph"] retains # CodeGraph but still drops the rest', () => {
    const out = stripCodingSections(fakeOrigin(), ['codegraph'])
    expect(out.some((s) => s.trim().startsWith('# CodeGraph'))).toBe(true)
    expect(out.some((s) => s.trim().startsWith('You are an interactive agent'))).toBe(false)
    expect(out.some((s) => s.trim().startsWith('# Doing tasks'))).toBe(false)
    expect(out.some((s) => s.trim().startsWith('Session ticket id:'))).toBe(false)
  })
})

describe('non-default agents strip coding sections from origin', () => {
  // 需求讨论型 agent 保留 # CodeGraph(澄清需求要先看代码对齐);
  // office / agent-creator 全剔除。
  const cases = [
    ['office', officeMainAgent, false],
    ['agent-creator', agentCreatorMainAgent, false],
    ['task-factory', taskFactoryMainAgent, true],
    ['task-intake', taskIntakeMainAgent, true],
  ] as const

  for (const [name, agent, keepsCodeGraph] of cases) {
    it(`${name}: systemPrompt slot drops coding sections (codegraph kept=${keepsCodeGraph}), keeps identity + general`, async () => {
      const slot = agent.systemPrompt
      expect(typeof slot).toBe('function')
      const resolved = await slot!(fakeOrigin())
      for (const prefix of CODING_SECTIONS) {
        if (keepsCodeGraph && prefix === '# CodeGraph') continue
        expect(resolved.some((s) => s.trim().startsWith(prefix))).toBe(false)
      }
      if (keepsCodeGraph) {
        expect(resolved.some((s) => s.trim().startsWith('# CodeGraph'))).toBe(true)
      }
      // boundary + general sections survive
      expect(resolved).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      expect(resolved.some((s) => s.startsWith('# System'))).toBe(true)
    })
  }
})
