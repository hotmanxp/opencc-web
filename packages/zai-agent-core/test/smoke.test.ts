// test/smoke.test.ts
import { describe, expect, test } from 'vitest'
import { VERSION } from '../src/index.js'

describe('smoke', () => {
  test('pkg exports version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
