import { describe, expect, it } from 'vitest'
import {
  noopReactNode,
  falseFn,
  trueFn,
  defaultDescription,
  defaultUserFacingName,
} from '../../../src/compat/runtime/openccToolDefaults.js'

describe('openccToolDefaults', () => {
  it('noopReactNode returns null', () => {
    expect(noopReactNode()).toBeNull()
  })

  it('falseFn returns false', () => {
    expect(falseFn()).toBe(false)
  })

  it('trueFn returns true', () => {
    expect(trueFn()).toBe(true)
  })

  it('defaultDescription returns generic stub', async () => {
    await expect(defaultDescription({} as any, {} as any)).resolves.toBe('(no description)')
  })

  it('defaultUserFacingName returns input name', () => {
    expect(defaultUserFacingName({ name: 'MyTool' } as any)).toBe('MyTool')
  })
})
