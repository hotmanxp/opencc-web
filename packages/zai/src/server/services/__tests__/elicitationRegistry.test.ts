// @ts-nocheck
import { ElicitationRegistry } from '../elicitationRegistry.js'
import { randomUUID } from 'crypto'

describe('ElicitationRegistry', () => {
  it('request returns pending promise', async () => {
    const reg = new ElicitationRegistry()
    const id = randomUUID()
    const promise = reg.request({
      elicitationId: id,
      mcpServerName: 'test-mcp',
      message: 'please fill form',
      mode: 'form',
      requestedSchema: { type: 'object', properties: { x: { type: 'string' } } },
    })
    // promise is pending (not resolved, not rejected)
    let resolved = false
    promise.then(() => { resolved = true }, () => { resolved = true })
    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(false)
    reg.cancel(id)
    await promise
  })

  it('resolve with action=accept', async () => {
    const reg = new ElicitationRegistry()
    const id = randomUUID()
    const promise = reg.request({
      elicitationId: id,
      mcpServerName: 'test-mcp',
      message: 'form',
      mode: 'form',
    })
    setTimeout(() => reg.resolve(id, { action: 'accept', content: { x: 'y' } }), 10)
    const result = await promise
    expect(result.action).toBe('accept')
    expect(result.content).toEqual({ x: 'y' })
  })

  it('cancel resolves with action=cancel', async () => {
    const reg = new ElicitationRegistry()
    const id = randomUUID()
    const promise = reg.request({
      elicitationId: id,
      mcpServerName: 'test-mcp',
      message: 'form',
      mode: 'form',
    })
    setTimeout(() => reg.cancel(id), 10)
    const result = await promise
    expect(result.action).toBe('cancel')
  })

  it('orphan resolve is no-op', () => {
    const reg = new ElicitationRegistry()
    expect(() => reg.resolve(randomUUID(), { action: 'accept' })).not.toThrow()
  })

  it('hasPending tracks request lifecycle', async () => {
    const reg = new ElicitationRegistry()
    expect(reg.hasPending()).toBe(false)
    const id = randomUUID()
    const promise = reg.request({
      elicitationId: id,
      mcpServerName: 'test-mcp',
      message: 'form',
      mode: 'form',
    })
    expect(reg.hasPending()).toBe(true)
    setTimeout(() => reg.resolve(id, { action: 'accept' }), 10)
    await promise
    expect(reg.hasPending()).toBe(false)
  })
})
