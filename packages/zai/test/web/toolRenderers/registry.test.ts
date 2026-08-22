// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { getRenderer, _renderersForTest } from '../../../src/web/src/components/toolRenderers/registry.js'
import { diffRenderer } from '../../../src/web/src/components/toolRenderers/diff.js'
import { readRenderer } from '../../../src/web/src/components/toolRenderers/read.js'
import { grepRenderer } from '../../../src/web/src/components/toolRenderers/grep.js'

// dsh 内核工具名 (packages/dsh-bridge/src/tools/{fs,ripgrep}.ts) 在 registry
// 里应该有 alias,否则 ToolCallBlock 会降级到 genericRenderer,丢失专用 UI。

describe('registry — opencc 工具名', () => {
  it('Edit/Read/Write/Grep 仍然命中专用 renderer', () => {
    expect(getRenderer('Edit')).toBe(diffRenderer)
    expect(getRenderer('Read')).toBe(readRenderer)
    expect(getRenderer('Write')).toBe(diffRenderer)
    expect(getRenderer('Grep')).toBe(grepRenderer)
  })
})

describe('registry — dsh 别名', () => {
  it('FileEdit 走 diffRenderer', () => {
    expect(getRenderer('FileEdit')).toBe(diffRenderer)
  })
  it('FileWrite 走 diffRenderer', () => {
    expect(getRenderer('FileWrite')).toBe(diffRenderer)
  })
  it('FileRead 走 readRenderer', () => {
    expect(getRenderer('FileRead')).toBe(readRenderer)
  })
  it('Ripgrep 走 grepRenderer', () => {
    expect(getRenderer('Ripgrep')).toBe(grepRenderer)
  })

  it('静态 registry 同时注册 opencc + dsh 名字', () => {
    const reg = _renderersForTest()
    expect(reg.Edit).toBe(diffRenderer)
    expect(reg.FileEdit).toBe(diffRenderer)
    expect(reg.FileWrite).toBe(diffRenderer)
    expect(reg.Write).toBe(diffRenderer)
    expect(reg.FileRead).toBe(readRenderer)
    expect(reg.Read).toBe(readRenderer)
    expect(reg.Ripgrep).toBe(grepRenderer)
    expect(reg.Grep).toBe(grepRenderer)
  })
})

describe('registry — 未知工具走 generic', () => {
  it('完全未注册的工具名走 generic(降级路径)', () => {
    const r = getRenderer('SomeUnknownTool')
    expect(r).toBeDefined()
    // genericRenderer 的 preview 行为: 取 input 第一个字段值截 80 字符
    expect(r.preview({ foo: 'bar' })).toBe('bar')
  })
})