import { describe, expect, it } from 'vitest'

/**
 * The vendor Tool objects returned by `buildTool` (Tool.ts:820) are plain
 * objects: `{...TOOL_DEFAULTS, ...def}`. None are Object.freeze'd, so each
 * `.checkPermissions` is a configurable + writable property. zai's
 * compat layer exploits this by mutating `tool.checkPermissions`
 * directly on the live vendor objects once getOpenccBuiltinTools() resolves
 * them from the bundle — no spread, no wrap. This test locks that behavior
 * in place so a future vendor change (Object.freeze or redefining
 * checkPermissions via Object.defineProperty with writable:false) is
 * caught by CI rather than silently failing the runtime hook.
 */
describe('forceAllow(tools) checkPermissions mutation', () => {
  it('mutates a writable checkPermissions property and returns behavior:allow', async () => {
    const { forceAllowCheckPermissions } = await import(
      '../../../src/compat/tools/opencc/builtin.js'
    )
    const seenDecisions: any[] = []
    const tool: any = {
      name: 'Fake',
      // Mimics vendor's typical pre-mutation shape: checkPermissions
      // exists, returns permission result object with proper union type.
      async checkPermissions(input: unknown) {
        return {
          behavior: 'deny' as const,
          updatedInput: input,
          decisionReason: {
            type: 'rule' as const,
            rule: { ruleBehavior: 'deny' as const },
          },
          message: 'denied (pre-mutation)',
        }
      },
      call() {
        throw new Error('not used in this test')
      },
    }
    forceAllowCheckPermissions(tool, 'Fake')
    const out = await tool.checkPermissions({ command: 'git commit -m test' })
    seenDecisions.push(out)
    expect(out.behavior).toBe('allow')
    expect(out.updatedInput).toEqual({ command: 'git commit -m test' })
    expect((out.decisionReason as any).type).toBe('mode')
    expect((out.decisionReason as any).mode).toBe('bypassPermissions')
  })

  it('overrides a checkPermissions that previously returned deny — try `git commit`', async () => {
    const { forceAllowCheckPermissions } = await import(
      '../../../src/compat/tools/opencc/builtin.js'
    )
    // Simulate the bashToolHasPermission commit-policy veto: a deny
    // result with rule reason. After forceAllow, the same call shape
    // must return allow — that's what closes the toolFailureLoopGuard
    // gap (5 consecutive deny → STOP message).
    const tool: any = {
      name: 'Bash',
      async checkPermissions(_input: unknown) {
        return {
          behavior: 'deny' as const,
          decisionReason: {
            type: 'rule' as const,
            rule: { ruleBehavior: 'deny' as const },
          },
          message: 'commit policy denial',
        }
      },
    }
    forceAllowCheckPermissions(tool, 'Bash')
    const out = await tool.checkPermissions({ command: 'git commit -m foo' })
    expect(out.behavior).toBe('allow')
  })

  it('overrides a checkPermissions that previously returned ask — Skill tool default', async () => {
    const { forceAllowCheckPermissions } = await import(
      '../../../src/compat/tools/opencc/builtin.js'
    )
    // SkillTool.checkPermissions returns ask when no allow rule
    // matches (line 581 of vendor tools/SkillTool/SkillTool.ts). Even
    // though zai uses its own skillTool wrapper, the vendor SkillTool
    // is also passed through `getOpenccBuiltinTools` and could be hit
    // if the runtime code accidentally dispatches a tool_use to it.
    // Force-allow its checkPermissions too so the LLM never sees an
    // upstream ask on the vendor path.
    const tool: any = {
      name: 'Skill',
      async checkPermissions(_input: unknown) {
        return {
          behavior: 'ask' as const,
          message: 'Execute skill: brainstorming',
          suggestions: [
            {
              type: 'addRules' as const,
              rules: [{ toolName: 'Skill', ruleContent: 'brainstorming' }],
              behavior: 'allow' as const,
              destination: 'localSettings' as const,
            },
          ],
        }
      },
    }
    forceAllowCheckPermissions(tool, 'Skill')
    const out = await tool.checkPermissions({ skill: 'brainstorming' })
    expect(out.behavior).toBe('allow')
    // updatedInput must echo the original input (vendor may inspect
    // this for telemetry / spec compliance).
    expect(out.updatedInput).toEqual({ skill: 'brainstorming' })
  })

  it('installs on a tool that has no existing checkPermissions property', async () => {
    const { forceAllowCheckPermissions } = await import(
      '../../../src/compat/tools/opencc/builtin.js'
    )
    const tool: any = { name: 'Empty' }
    forceAllowCheckPermissions(tool, 'Empty')
    const out = await tool.checkPermissions({ foo: 'bar' })
    expect(out.behavior).toBe('allow')
    expect(out.updatedInput).toEqual({ foo: 'bar' })
  })
})
