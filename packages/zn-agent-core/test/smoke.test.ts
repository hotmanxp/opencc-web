import { describe, it, expect } from 'vitest'
import * as main from '../src/index.js'
import * as runtime from '../src/runtime/index.js'

describe('zn-agent-core smoke', () => {
  it('main entry exports VERSION', () => {
    expect(main.VERSION).toBe('0.1.0')
  })
  it('main entry exports EXTERNAL_PERMISSION_MODES', () => {
    expect(main.EXTERNAL_PERMISSION_MODES).toBeDefined()
  })
  it('runtime exports CwdStore singleton', () => {
    expect(runtime.CwdStore).toBeDefined()
    expect(typeof runtime.CwdStore.get).toBe('function')
  })
  it('runtime exports runWithSessionId', () => {
    expect(typeof runtime.runWithSessionId).toBe('function')
  })
})