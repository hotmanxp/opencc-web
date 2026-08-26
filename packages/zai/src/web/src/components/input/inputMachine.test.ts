/**
 * InputMachine 单元测试:事务、reconcile、chip 插入/整删、undo/redo、
 * 剪贴板展开、外部插入。无 React/DOM 依赖。
 */
import { describe, expect, it } from 'vitest'
import {
  InputMachine,
  PLACEHOLDER,
  projectClipboard,
} from './inputMachine.js'

const REF = (path: string, label = path.split('/').pop() ?? path) => ({
  source: 'fs',
  ref: path,
  label,
  clipboardText: `@${path}`,
})

function machineWith(...refs: { path: string; label?: string }[]): InputMachine {
  const m = new InputMachine()
  let caret = 0
  for (const r of refs) {
    m.dispatch({
      type: 'insert-reference',
      reference: REF(r.path, r.label),
      span: { start: caret, end: caret, draftRev: m.state.draftRev },
    })
    caret = m.state.draft.length
  }
  return m
}

describe('InputMachine', () => {
  it('打字符号会将草稿写入 draft', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'hello' })
    expect(m.state.draft).toBe('hello')
    expect(m.state.occurrences).toEqual([])
  })

  it('插入引用:token span 被替换为 U+FFFC + 尾随空格,occurrence 记录', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: '看看 @src/a.ts then' })
    const rev = m.state.draftRev
    m.dispatch({
      type: 'insert-reference',
      reference: REF('src/a.ts'),
      span: { start: 3, end: 13, draftRev: rev },
    })
    expect(m.state.draft).toBe(`看看 ${PLACEHOLDER} then`)
    expect(m.state.occurrences).toHaveLength(1)
    expect(m.state.occurrences[0]?.source).toBe('fs')
    expect(m.state.occurrences[0]?.ref).toBe('src/a.ts')
    expect(m.state.occurrences[0]?.offset).toBe(3)
    expect(m.state.occurrences[0]?.clipboardText).toBe('@src/a.ts')
  })

  it('span 后已经是空格时不重复加空格', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: '@a  tail' })
    m.dispatch({
      type: 'insert-reference',
      reference: REF('a'),
      span: { start: 0, end: 2, draftRev: m.state.draftRev },
    })
    expect(m.state.draft).toBe(`${PLACEHOLDER}  tail`)
  })

  it('draft-changed 穿越占位符:删除整 chip', () => {
    const m = machineWith({ path: 'a.ts' })
    const before = m.state.draft
    expect(before).toBe(`${PLACEHOLDER} `)
    // 用户按 Backspace 删掉占位符 → textarea 给出删除后的 draft
    m.dispatch({ type: 'draft-changed', draft: ' ' })
    expect(m.state.occurrences).toHaveLength(0)
  })

  it('在 chip 之后打字,occurrence offset 不变(插入发生在占位符之后)', () => {
    const m = machineWith({ path: 'a.ts' })
    // draft = "￼ " → 变 "￼ abc"
    m.dispatch({ type: 'draft-changed', draft: `${PLACEHOLDER} abc` })
    expect(m.state.occurrences[0]?.offset).toBe(0)
  })

  it('在 chip 之前打字,occurrence offset 右移', () => {
    const m = machineWith({ path: 'a.ts' })
    // draft = "￼ " → 变 "xx￼ "
    m.dispatch({ type: 'draft-changed', draft: `xx${PLACEHOLDER} ` })
    expect(m.state.occurrences[0]?.offset).toBe(2)
  })

  it('consume-span 删除原 token 文本', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'abc @src/' })
    m.dispatch({
      type: 'consume-span',
      span: { start: 4, end: 9, draftRev: m.state.draftRev },
    })
    expect(m.state.draft).toBe('abc ')
  })

  it('projectClipboard 把占位符展开为剪贴板投影', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: '前缀 ' })
    m.dispatch({
      type: 'insert-reference',
      reference: REF('src/deep/path.ts'),
      span: { start: 3, end: 3, draftRev: m.state.draftRev },
    })
    expect(projectClipboard(m.state)).toBe('前缀 @src/deep/path.ts ')
  })

  it('undo 撤销引用插入,redo 重做', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: '@a' })
    m.dispatch({
      type: 'insert-reference',
      reference: REF('a'),
      span: { start: 0, end: 2, draftRev: m.state.draftRev },
    })
    expect(m.state.draft).toBe(`${PLACEHOLDER} `)
    m.dispatch({ type: 'undo' })
    expect(m.state.draft).toBe('@a')
    m.dispatch({ type: 'redo' })
    expect(m.state.draft).toBe(`${PLACEHOLDER} `)
    expect(m.state.occurrences).toHaveLength(1)
  })

  it('undo 撤销引用后草案可继续编辑', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'x@a' })
    m.dispatch({
      type: 'insert-reference',
      reference: REF('a'),
      span: { start: 1, end: 3, draftRev: m.state.draftRev },
    })
    m.dispatch({ type: 'undo' })
    m.dispatch({ type: 'draft-changed', draft: 'xy@a' })
    expect(m.state.draft).toBe('xy@a')
    expect(m.state.occurrences).toHaveLength(0)
  })

  it('连续打字合并为一次 undo(typing merge),undo 一步回到输入前', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'h' })
    m.dispatch({ type: 'draft-changed', draft: 'he' })
    m.dispatch({ type: 'draft-changed', draft: 'hel' })
    m.dispatch({ type: 'draft-changed', draft: 'hell' })
    m.dispatch({ type: 'draft-changed', draft: 'hello' })
    m.dispatch({ type: 'undo' })
    expect(m.state.draft).toBe('')
    m.dispatch({ type: 'redo' })
    expect(m.state.draft).toBe('hello')
  })

  it('insertTextAt 在光标处插入外部纯文本', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'ab' })
    m.insertTextAt('XY', 1)
    expect(m.state.draft).toBe('aXYb')
  })

  it('insertTextAt 不受 occurrence 干扰(offset 平移)', () => {
    const m = machineWith({ path: 'a.ts' })
    m.insertTextAt('Z', 0)
    expect(m.state.draft).toBe(`Z${PLACEHOLDER} `)
    expect(m.state.occurrences[0]?.offset).toBe(1)
  })

  it('insertReferenceAt 在光标处插入 chip(光标前非空白补前置空格,尾部补尾随空格)', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'abc def' })
    m.insertReferenceAt(REF('src/a.ts'), 4) // 插到 "abc |def"
    // 前一个字符是空格 → 无前置空格;tail 首字符 'd' 非空格 → 尾随空格
    expect(m.state.draft).toBe(`abc ${PLACEHOLDER} def`)
    expect(m.state.occurrences).toHaveLength(1)
    expect(m.state.occurrences[0]?.ref).toBe('src/a.ts')
    expect(m.state.occurrences[0]?.offset).toBe(4)
  })

  it('insertReferenceAt 在词中间插入时补前置空格(分隔语义)', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'ab' })
    m.insertReferenceAt(REF('a.ts'), 1) // 插到 "a|b" → "a ￼ b"
    expect(m.state.draft).toBe(`a ${PLACEHOLDER} b`)
    expect(m.state.occurrences[0]?.offset).toBe(2)
  })

  it('insertReferenceAt 在末尾插入时只补尾随空格', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'word' })
    m.insertReferenceAt(REF('a.ts'), 4)
    expect(m.state.draft).toBe(`word ${PLACEHOLDER} `)
  })

  it('insertReferenceAt 后 undo 恢复原草稿(事务)', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: 'abc' })
    m.insertReferenceAt(REF('a.ts'), 0)
    expect(m.state.occurrences).toHaveLength(1)
    m.dispatch({ type: 'undo' })
    expect(m.state.draft).toBe('abc')
    expect(m.state.occurrences).toHaveLength(0)
  })

  it('insert-reference 带 stale draftRev 时拒绝(CAS)', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: '@a' })
    const stale = m.state.draftRev - 1
    m.dispatch({
      type: 'insert-reference',
      reference: REF('a'),
      span: { start: 0, end: 2, draftRev: stale },
    })
    expect(m.state.draft).toBe('@a') // 未被改
  })

  it('粘贴的文本中含 U+FFFC 时按占位符处理(不会凭空多 chip)', () => {
    const m = new InputMachine()
    m.dispatch({ type: 'draft-changed', draft: `${PLACEHOLDER}` })
    expect(m.state.occurrences).toHaveLength(0)
  })
})