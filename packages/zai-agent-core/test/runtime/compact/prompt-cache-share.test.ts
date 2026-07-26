import { describe, expect, it } from 'vitest'
import { isCompactionCacheSharingCompatible } from '../../../src/runtime/compact/prompt-cache-share.js'

describe('isCompactionCacheSharingCompatible', () => {
  it("'anthropic' → true", () => expect(isCompactionCacheSharingCompatible('anthropic')).toBe(true))
  it("'openai' → false", () => expect(isCompactionCacheSharingCompatible('openai')).toBe(false))
  it("'custom' → false", () => expect(isCompactionCacheSharingCompatible('custom')).toBe(false))
  it('undefined → false', () => expect(isCompactionCacheSharingCompatible(undefined)).toBe(false))
  it('null → false', () => expect(isCompactionCacheSharingCompatible(null)).toBe(false))
})