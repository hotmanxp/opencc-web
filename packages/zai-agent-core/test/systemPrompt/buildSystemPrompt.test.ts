import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildSystemPrompt,
  buildEffectiveSystemPrompt,
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  clearSystemPromptSections,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  asSystemPrompt,
  type SystemPromptSection,
} from '../../src/systemPrompt/index.js'

describe('systemPrompt — type & boundary', () => {
  it('exports the canonical boundary string', () => {
    expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  })

  it('asSystemPrompt wraps a readonly array without runtime change', () => {
    const branded = asSystemPrompt(['hello'])
    // The __brand is a phantom TS property — not present at runtime.
    // The cast at runtime returns the same array reference; verify shape
    // rather than the phantom field.
    expect(Array.isArray(branded)).toBe(true)
    expect(branded[0]).toBe('hello')
    expect(branded.length).toBe(1)
  })
})

describe('systemPrompt — section registry', () => {
  beforeEach(() => clearSystemPromptSections())

  it('caches a section after first compute', async () => {
    let calls = 0
    const sec = systemPromptSection('counter', () => {
      calls++
      return 'hello'
    })

    // Explicit empty intro → no DEFAULT_STATIC_INTRO filler → easy to assert.
    const a = await buildSystemPrompt({ staticIntro: [], sections: [sec] })
    const b = await buildSystemPrompt({ staticIntro: [], sections: [sec] })

    expect(a).toEqual([SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'hello'])
    expect(b).toEqual(a)
    expect(calls).toBe(1)
  })

  it('DANGEROUS_uncached recomputes on every call', async () => {
    let calls = 0
    const sec = DANGEROUS_uncachedSystemPromptSection(
      'always-fresh',
      () => {
        calls++
        return 'tick'
      },
      'test: recompute every time',
    )

    await buildSystemPrompt({ sections: [sec] })
    await buildSystemPrompt({ sections: [sec] })
    expect(calls).toBe(2)
  })

  it('drops sections that compute to null', async () => {
    const sec = systemPromptSection('null-section', () => null)
    // Pass an explicit (empty) staticIntro so DEFAULT_STATIC_INTRO does
    // NOT fill the static half — we want to verify null filtering alone.
    const out = await buildSystemPrompt({ staticIntro: [], sections: [sec] })
    // Empty intro + filtered null section → only the boundary marker.
    expect(out).toEqual([SYSTEM_PROMPT_DYNAMIC_BOUNDARY])
  })

  it('uses DEFAULT_STATIC_INTRO when no staticIntro is provided', async () => {
    const sec = systemPromptSection('plain', () => 'dyn')
    const out = await buildSystemPrompt({ sections: [sec] })
    // DEFAULT_STATIC_INTRO has 7 sections (indices 0..6), then the
    // boundary marker at index 7, then 'dyn' at index 8.
    expect(out.length).toBe(7 + 2)
    expect(out[0]).toContain('interactive agent')
    expect(out[7]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    expect(out[8]).toBe('dyn')
  })

  it('accepts a string as staticIntro', async () => {
    const sec = systemPromptSection('plain', () => 'dyn')
    const out = await buildSystemPrompt({
      staticIntro: 'one-off intro',
      sections: [sec],
    })
    expect(out[0]).toBe('one-off intro')
    expect(out[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    expect(out[2]).toBe('dyn')
  })

  it('clearSystemPromptSections forces recompute', async () => {
    let calls = 0
    const sec = systemPromptSection('counter', () => {
      calls++
      return 'x'
    })
    await buildSystemPrompt({ sections: [sec] })
    expect(calls).toBe(1)

    clearSystemPromptSections()
    await buildSystemPrompt({ sections: [sec] })
    expect(calls).toBe(2)
  })
})

describe('systemPrompt — buildEffectiveSystemPrompt', () => {
  beforeEach(() => clearSystemPromptSections())

  it('returns the override block alone (with append)', async () => {
    const out = await buildEffectiveSystemPrompt({
      sections: [],
      overrideSystemPrompt: 'override!',
      appendSystemPrompt: 'appended',
    })
    expect(out).toEqual(['override!', 'appended'])
  })

  it('uses customSystemPrompt as static intro when no override', async () => {
    const sec: SystemPromptSection = systemPromptSection('d', () => 'dynamic')
    const out = await buildEffectiveSystemPrompt({
      sections: [sec],
      customSystemPrompt: 'custom',
    })
    expect(out[0]).toBe('custom')
    expect(out[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    expect(out[2]).toBe('dynamic')
  })

  it('falls back to DEFAULT_STATIC_INTRO when neither override nor custom', async () => {
    const sec: SystemPromptSection = systemPromptSection('d', () => 'dynamic')
    const out = await buildEffectiveSystemPrompt({
      sections: [sec],
    })
    expect(out.length).toBe(7 + 2)
    expect(out[0]).toContain('interactive agent')
    expect(out[7]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    expect(out[8]).toBe('dynamic')
  })

  it('splices appendSystemPrompt right after the boundary', async () => {
    const sec: SystemPromptSection = systemPromptSection('d', () => 'dyn')
    const out = await buildEffectiveSystemPrompt({
      sections: [sec],
      customSystemPrompt: 'c',
      appendSystemPrompt: 'A',
    })
    expect(out).toEqual([
      'c',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'A',
      'dyn',
    ])
  })
})