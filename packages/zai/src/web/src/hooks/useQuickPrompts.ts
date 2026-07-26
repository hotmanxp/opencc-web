import { useCallback, useEffect, useRef, useState } from 'react'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'

export interface QuickPrompt {
  id: string
  text: string
  createdAt: number
}

export interface UseQuickPromptsResult {
  prompts: QuickPrompt[]
  add: (text: string) => QuickPrompt | null
  remove: (id: string) => void
  clear: () => void
}

export const MAX_PROMPTS = 50
export const MIN_TEXT = 1
export const MAX_TEXT = 200

export const DEFAULT_QUICK_PROMPTS_SEED: ReadonlyArray<{ text: string }> = [
  { text: '优化这段代码的可读性与性能' },
  { text: '为这段函数补上单元测试' },
  { text: '解释这个错误的根因,并给出修复建议' },
]

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* fallback */
  }
  return `qp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function loadFromStorage(): QuickPrompt[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.quickPrompts)
    if (raw === null) return null  // key missing → null → seed later
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []  // corrupt (not array) → []
    return parsed as QuickPrompt[]
  } catch {
    return []  // JSON.parse threw → [], don't seed (corrupt ≠ first-use)
  }
}

function saveToStorage(prompts: QuickPrompt[]): void {
  try {
    const serialized = JSON.stringify(prompts)
    localStorage.setItem(STORAGE_KEYS.quickPrompts, serialized)
    window.dispatchEvent(
      new CustomEvent('zai-localstorage-sync', {
        detail: { key: STORAGE_KEYS.quickPrompts, value: serialized },
      }),
    )
  } catch {
    /* quota / privacy mode — silently ignore */
  }
}

function seedPrompts(): QuickPrompt[] {
  const now = Date.now()
  const seeded = DEFAULT_QUICK_PROMPTS_SEED.map((s, i) => ({
    id: genId(),
    text: s.text,
    createdAt: now + i,
  }))
  saveToStorage(seeded)
  // eslint-disable-next-line no-console
  console.info('[quick-prompts] seeded', seeded.length, 'default prompts')
  return seeded
}

export function useQuickPrompts(): UseQuickPromptsResult {
  const [prompts, setPrompts] = useState<QuickPrompt[]>(() => {
    const existing = loadFromStorage()
    if (existing !== null) return existing
    return seedPrompts()
  })
  const promptsRef = useRef<QuickPrompt[]>(prompts)

  useEffect(() => {
    promptsRef.current = prompts
  }, [prompts])

  // 跨 tab / 同 tab 同步 — 监听 storage 与 zai-localstorage-sync。
  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ key: string; value: string | null }>).detail
      if (!detail || detail.key !== STORAGE_KEYS.quickPrompts) return
      if (detail.value === null) return
      try {
        const parsed = JSON.parse(detail.value) as QuickPrompt[]
        if (Array.isArray(parsed)) {
          setPrompts(parsed)
          promptsRef.current = parsed
        }
      } catch {
        /* ignore corrupt */
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEYS.quickPrompts) return
      if (e.newValue === null) return
      try {
        const parsed = JSON.parse(e.newValue) as QuickPrompt[]
        if (Array.isArray(parsed)) setPrompts(parsed)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('zai-localstorage-sync', onSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('zai-localstorage-sync', onSync)
    }
  }, [])

  const add = useCallback((text: string): QuickPrompt | null => {
    const trimmed = text.trim()
    if (trimmed.length < MIN_TEXT || trimmed.length > MAX_TEXT) return null
    const current = promptsRef.current
    if (current.some((p) => p.text === trimmed)) return null
    const item: QuickPrompt = {
      id: genId(),
      text: trimmed,
      createdAt: Date.now(),
    }
    let next: QuickPrompt[]
    if (current.length >= MAX_PROMPTS) {
      // 截断最旧 (createdAt 升序)
      next = [...current.slice(current.length - MAX_PROMPTS + 1), item]
    } else {
      next = [...current, item]
    }
    setPrompts(next)
    promptsRef.current = next
    saveToStorage(next)
    return item
  }, [])

  const remove = useCallback((id: string) => {
    const next = promptsRef.current.filter((p) => p.id !== id)
    setPrompts(next)
    promptsRef.current = next
    saveToStorage(next)
  }, [])

  const clear = useCallback(() => {
    setPrompts([])
    promptsRef.current = []
    saveToStorage([])
  }, [])

  return { prompts, add, remove, clear }
}
