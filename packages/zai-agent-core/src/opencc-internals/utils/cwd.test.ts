import { describe, it, expect, beforeEach } from 'vitest'
import { runWithSessionId, getCwd, runWithCwdOverride, getCurrentSessionId } from './cwd.js'
import { CwdStore } from '../../runtime/cwdStore.js'

describe('cwd ALS sessionId integration', () => {
  beforeEach(() => {
    CwdStore.clear()
  })

  it('getCwd outside ALS returns process.cwd()', () => {
    expect(getCwd()).toBe(process.cwd())
  })

  it('getCwd inside runWithSessionId returns CwdStore entry', () => {
    runWithSessionId('sess-1', () => {
      CwdStore.set('sess-1', '/tmp/one')
      expect(getCwd()).toBe('/tmp/one')
    })
  })

  it('getCurrentSessionId returns sid inside ALS', () => {
    runWithSessionId('sess-2', () => {
      expect(getCurrentSessionId()).toBe('sess-2')
    })
    expect(getCurrentSessionId()).toBeUndefined()
  })

  it('nested runWithSessionId uses inner sid', () => {
    CwdStore.set('sess-outer', '/outer')
    CwdStore.set('sess-inner', '/inner')
    runWithSessionId('sess-outer', () => {
      expect(getCwd()).toBe('/outer')
      runWithSessionId('sess-inner', () => {
        expect(getCwd()).toBe('/inner')
      })
      expect(getCwd()).toBe('/outer')
    })
  })

  it('runWithCwdOverride still overrides inside ALS', () => {
    CwdStore.set('sess-3', '/from-store')
    runWithSessionId('sess-3', () => {
      expect(getCwd()).toBe('/from-store')
      runWithCwdOverride('/forced', () => {
        expect(getCwd()).toBe('/forced')
      })
      expect(getCwd()).toBe('/from-store')
    })
  })
})