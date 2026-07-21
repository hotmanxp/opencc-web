import { describe, it, expect } from 'vitest'
import { computeLineDiff, summarizeDiff } from '../../src/web/src/lib/diff.js'

describe('computeLineDiff', () => {
  it('Write 场景: 旧侧为空 → 整篇都是 add, 行号 1..N', () => {
    const rows = computeLineDiff('', 'a\nb\nc')
    expect(rows.map((r) => r.kind)).toEqual(['add', 'add', 'add'])
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c'])
    expect(rows.map((r) => r.no)).toEqual([1, 2, 3])
    expect(summarizeDiff(rows)).toEqual({ added: 3, removed: 0 })
  })

  it('末尾换行不产生多余空行', () => {
    const rows = computeLineDiff('', 'a\nb\n')
    expect(rows.map((r) => r.text)).toEqual(['a', 'b'])
  })

  it('纯删除: 新侧为空', () => {
    const rows = computeLineDiff('x\ny', '')
    expect(rows.map((r) => r.kind)).toEqual(['del', 'del'])
    expect(summarizeDiff(rows)).toEqual({ added: 0, removed: 2 })
  })

  it('增删混合: 保留公共上下文, 只标出改动行', () => {
    // 旧: line1 / OLD / line3
    // 新: line1 / NEW / line3
    const rows = computeLineDiff('line1\nOLD\nline3', 'line1\nNEW\nline3')
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      'context:line1',
      'del:OLD',
      'add:NEW',
      'context:line3',
    ])
    expect(summarizeDiff(rows)).toEqual({ added: 1, removed: 1 })
  })

  it('纯新增行插入到中间: 上下文不动', () => {
    const rows = computeLineDiff('a\nc', 'a\nb\nc')
    expect(rows.map((r) => `${r.kind}:${r.text}`)).toEqual([
      'context:a',
      'add:b',
      'context:c',
    ])
    expect(summarizeDiff(rows)).toEqual({ added: 1, removed: 0 })
  })

  it('完全相同: 全部 context, 无增删', () => {
    const rows = computeLineDiff('a\nb', 'a\nb')
    expect(rows.every((r) => r.kind === 'context')).toBe(true)
    expect(summarizeDiff(rows)).toEqual({ added: 0, removed: 0 })
  })

  it('两侧都空: 无行', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })
})
