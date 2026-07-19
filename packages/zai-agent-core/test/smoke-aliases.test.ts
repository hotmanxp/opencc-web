/**
 * 注册表层 smoke test:验证 getZaiRuntimeTools() 构建出的工具实际可被
 * opencc `findToolByName` 按 BashOutput / AgentOutput / KillShell 别名查找命中。
 * 这条路径走的是 LegacyTool → wrapAsOpenccTool → opencc Tool.aliases 全链路。
 */
import { describe, expect, test } from 'vitest'
import { getZaiRuntimeTools } from '../src/tools/index.js'
import { findToolByName } from '../src/opencc-internals/Tool.js'
import { TaskOutputTool } from '../src/tools/TaskOutputTool/TaskOutputTool.js'
import { TaskStopTool } from '../src/tools/TaskStopTool/TaskStopTool.js'

describe('Tool registry — opencc aliases survive getZaiRuntimeTools()', () => {
  const tools = getZaiRuntimeTools()

  test('findToolByName(TaskOutput) returns TaskOutputTool', () => {
    const t = findToolByName(tools, 'TaskOutput')
    expect(t).toBeDefined()
    // Cross-check via primary name identity.
    expect((t as unknown as { name: string }).name).toBe(TaskOutputTool.name)
  })

  test('findToolByName(BashOutput) resolves to TaskOutputTool (alias hit)', () => {
    const t = findToolByName(tools, 'BashOutput')
    expect(t).toBeDefined()
    expect((t as unknown as { name: string }).name).toBe('TaskOutput')
  })

  test('findToolByName(AgentOutput) resolves to TaskOutputTool (alias hit)', () => {
    const t = findToolByName(tools, 'AgentOutput')
    expect(t).toBeDefined()
    expect((t as unknown as { name: string }).name).toBe('TaskOutput')
  })

  test('findToolByName(TaskStop) returns TaskStopTool', () => {
    const t = findToolByName(tools, 'TaskStop')
    expect(t).toBeDefined()
    expect((t as unknown as { name: string }).name).toBe(TaskStopTool.name)
  })

  test('findToolByName(KillShell) resolves to TaskStopTool (alias hit)', () => {
    const t = findToolByName(tools, 'KillShell')
    expect(t).toBeDefined()
    expect((t as unknown as { name: string }).name).toBe('TaskStop')
  })

  test('findToolByName(UnknownTool) returns undefined', () => {
    expect(findToolByName(tools, 'UnknownTool')).toBeUndefined()
  })

  test('registry contains no duplicate primary/alias across distinct tools', () => {
    // Primary names vs aliases must not collide (would cause tool resolution
    // ambiguity). Check both directions.
    const primaries = new Set<string>()
    const aliasOwners = new Map<string, string>()
    for (const t of tools) {
      const tn = t as unknown as { name: string; aliases?: string[] }
      primaries.add(tn.name)
      for (const a of tn.aliases ?? []) {
        if (aliasOwners.has(a) && aliasOwners.get(a) !== tn.name) {
          throw new Error(
            `Alias '${a}' claimed by both '${aliasOwners.get(a)}' and '${tn.name}'`,
          )
        }
        if (primaries.has(a)) {
          throw new Error(`Alias '${a}' collides with another tool's primary name`)
        }
        aliasOwners.set(a, tn.name)
      }
    }
    // Sanity: expect at least 1 alias registered (the ones we just added).
    expect(aliasOwners.has('BashOutput')).toBe(true)
    expect(aliasOwners.has('AgentOutput')).toBe(true)
    expect(aliasOwners.has('KillShell')).toBe(true)
  })
})
