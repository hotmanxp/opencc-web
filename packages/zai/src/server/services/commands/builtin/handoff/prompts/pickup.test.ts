import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { buildPickupPrompt } from './pickup.js'

const baseParams = {
  cwd: '/Users/x/project',
  root: '/Users/x/project/.agent_working_dir/handoff',
  date: '2026-08-16',
}

describe('buildPickupPrompt', () => {
  it('0 文件返回友好提示', () => {
    const out = buildPickupPrompt({ ...baseParams, files: [] })
    expect(out).toContain('未找到')
    expect(out).toContain(baseParams.root)
    expect(out).toContain(baseParams.date)
  })

  it('1 文件无 pickFile 时让 LLM 直接 Read', () => {
    const file = path.join(baseParams.root, 'only.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [{ path: file, mtimeMs: Date.now() }],
    })
    expect(out).toContain('Read')
    expect(out).toContain(file)
  })

  it('多文件无 pickFile 时列文件并用 AskUserQuestion', () => {
    const a = path.join(baseParams.root, 'a.md')
    const b = path.join(baseParams.root, 'b.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [
        { path: a, mtimeMs: Date.now() },
        { path: b, mtimeMs: Date.now() - 1000 },
      ],
    })
    expect(out).toContain('AskUserQuestion')
    expect(out).toContain(path.basename(a))
    expect(out).toContain(path.basename(b))
    expect(out).toContain(a)
    expect(out).toContain(b)
  })

  it('pickFile 命中文件时只 Read 该文件', () => {
    const a = path.join(baseParams.root, 'a.md')
    const b = path.join(baseParams.root, 'b.md')
    const out = buildPickupPrompt({
      ...baseParams,
      files: [
        { path: a, mtimeMs: Date.now() },
        { path: b, mtimeMs: Date.now() - 1000 },
      ],
      pickFile: 'b.md',
    })
    expect(out).toContain('Read')
    expect(out).toContain(b)
    expect(out).not.toContain(a)
  })

  it('pickFile 文件名不存在时抛 HandoffArgsError', () => {
    const a = path.join(baseParams.root, 'a.md')
    expect(() =>
      buildPickupPrompt({
        ...baseParams,
        files: [{ path: a, mtimeMs: Date.now() }],
        pickFile: 'nonexistent.md',
      }),
    ).toThrow(/--pick 指定的文件不存在/)
  })
})
