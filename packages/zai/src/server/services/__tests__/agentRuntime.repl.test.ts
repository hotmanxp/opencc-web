// @ts-nocheck
import { initAgentRuntime, getRuntime } from '../agentRuntime.js'

describe('agentRuntime three-way kernel switch', () => {
  beforeEach(async () => {
    process.env.ZAI_RUNTIME_KERNEL = 'repl'
    // Note: brief wrote `initAgentRuntime({ cwd: process.cwd() })` but
    // the actual signature is `initAgentRuntime(cwd: string, isSdk?)`.
    // Passing the object crashes on the post-runtime `initCommands` call
    // (`path argument must be of type string`); passing the bare cwd
    // string routes through ReplRuntime as the brief intends.
    await initAgentRuntime(process.cwd())
  })

  afterEach(() => {
    delete process.env.ZAI_RUNTIME_KERNEL
  })

  it('runtime.kernel=repl returns a ReplRuntime instance', () => {
    const runtime = getRuntime()
    expect(runtime).toBeDefined()
    expect(runtime.constructor.name).toBe('ReplRuntime')
  })

  it('repl runtime exposes submit + enqueue + interrupt', () => {
    const runtime = getRuntime() as any
    expect(typeof runtime.query).toBe('function')
    expect(typeof runtime.abort).toBe('function')
    expect(typeof runtime.enqueue).toBe('function')
    expect(typeof runtime.interrupt).toBe('function')
  })
})
