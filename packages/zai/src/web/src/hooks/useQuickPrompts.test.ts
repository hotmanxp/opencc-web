// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUICK_PROMPTS_SEED,
  MAX_PROMPTS,
  MAX_TEXT,
  useQuickPrompts,
} from './useQuickPrompts.js'

const KEY = 'zai.quickPrompts.v1'

function reset() {
  localStorage.clear()
}

beforeEach(reset)
afterEach(reset)

describe('useQuickPrompts — 初次挂载', () => {
  it('localStorage 无 key 时写入 3 条预填示例', () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toHaveLength(DEFAULT_QUICK_PROMPTS_SEED.length)
    expect(localStorage.getItem(KEY)).not.toBeNull()
    const stored = JSON.parse(localStorage.getItem(KEY)!)
    expect(stored.map((p: { text: string }) => p.text)).toEqual(
      DEFAULT_QUICK_PROMPTS_SEED.map((s) => s.text),
    )
  })

  it('已有 key 时不覆盖,沿用持久化内容', () => {
    const existing = [{ id: 'a', text: 'custom', createdAt: 1 }]
    localStorage.setItem(KEY, JSON.stringify(existing))
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toEqual(existing)
  })

  it('JSON.parse 失败 → fallback []', () => {
    localStorage.setItem(KEY, '{not json')
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toEqual([])
  })
})

describe('useQuickPrompts — add', () => {
  it('返回 QuickPrompt 对象,text 与 createdAt 正确', () => {
    const { result } = renderHook(() => useQuickPrompts())
    let added: ReturnType<typeof result.current.add> = null
    act(() => {
      added = result.current.add('  hello  ')
    })
    expect(added).not.toBeNull()
    expect(added!.text).toBe('hello')
    expect(typeof added!.id).toBe('string')
    expect(typeof added!.createdAt).toBe('number')
    expect(result.current.prompts).toHaveLength(DEFAULT_QUICK_PROMPTS_SEED.length + 1)
  })

  it('空字符串 / 仅空白 → 返回 null', () => {
    const { result } = renderHook(() => useQuickPrompts())
    const before = result.current.prompts.length
    expect(result.current.add('')).toBeNull()
    expect(result.current.add('   ')).toBeNull()
    expect(result.current.prompts.length).toBe(before)
  })

  it(`超过 ${MAX_TEXT} 字符 → 返回 null`, () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.add('a'.repeat(MAX_TEXT + 1))).toBeNull()
  })

  it('重复文本 → 返回 null', () => {
    const { result } = renderHook(() => useQuickPrompts())
    // 取预填示例第一条
    const existingText = DEFAULT_QUICK_PROMPTS_SEED[0]!.text
    expect(result.current.add(existingText)).toBeNull()
  })

  it(`达到 MAX_PROMPTS 时截断最旧(createdAt 升序)`, () => {
    localStorage.clear()
    const seed = Array.from({ length: MAX_PROMPTS }, (_, i) => ({
      id: `seed-${i}`,
      text: `seed ${i}`,
      createdAt: i,
    }))
    localStorage.setItem(KEY, JSON.stringify(seed))
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts).toHaveLength(MAX_PROMPTS)
    act(() => {
      result.current.add('newest')
    })
    expect(result.current.prompts).toHaveLength(MAX_PROMPTS)
    expect(result.current.prompts.at(-1)!.text).toBe('newest')
    // seed-0 是最旧的,被截断
    expect(result.current.prompts.find((p) => p.text === 'seed 0')).toBeUndefined()
  })
})

describe('useQuickPrompts — remove / clear', () => {
  it('remove 后数组与 localStorage 都清掉对应项', () => {
    const { result } = renderHook(() => useQuickPrompts())
    const first = result.current.prompts[0]!
    act(() => {
      result.current.remove(first.id)
    })
    expect(result.current.prompts.find((p) => p.id === first.id)).toBeUndefined()
    const stored = JSON.parse(localStorage.getItem(KEY)!)
    expect(stored.find((p: { id: string }) => p.id === first.id)).toBeUndefined()
  })

  it('clear 后数组为空,localStorage 写入 []', () => {
    const { result } = renderHook(() => useQuickPrompts())
    expect(result.current.prompts.length).toBeGreaterThan(0)
    act(() => {
      result.current.clear()
    })
    expect(result.current.prompts).toEqual([])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([])
  })
})
