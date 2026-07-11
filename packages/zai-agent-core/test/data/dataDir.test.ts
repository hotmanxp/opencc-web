import { describe, expect, test } from 'vitest'
import { resolveDataDir } from '../../src/data/dataDir.js'

describe('resolveDataDir', () => {
  test('defaults to ~/.zai when no override', () => {
    const result = resolveDataDir({ homedir: '/home/test' })
    expect(result.resolved).toBe('/home/test/.zai')
    expect(result.fromEnv).toBe(false)
    expect(result.fromCli).toBe(false)
  })

  test('cliOverride takes highest priority', () => {
    const result = resolveDataDir({
      cliOverride: '/tmp/zai-custom',
      envOverride: '/env/zai',
      homedir: '/home/test',
    })
    expect(result.resolved).toBe('/tmp/zai-custom')
    expect(result.fromCli).toBe(true)
    expect(result.fromEnv).toBe(false)
  })

  test('envOverride takes middle priority', () => {
    const result = resolveDataDir({
      envOverride: '/env/zai',
      homedir: '/home/test',
    })
    expect(result.resolved).toBe('/env/zai')
    expect(result.fromEnv).toBe(true)
    expect(result.fromCli).toBe(false)
  })
})
