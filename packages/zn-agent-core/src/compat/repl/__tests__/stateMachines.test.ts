// @ts-nocheck
import { vi } from 'vitest'
import {
  OnSubmitStateMachine,
  OnQueryStateMachine,
  OnQueryImplStateMachine,
} from '../stateMachines.js'

describe('OnSubmitStateMachine', () => {
  it('parse + enqueue; transition to OnQuery', () => {
    const cmdQueue = {
      enqueue: vi.fn(),
      drain: () => [],
      peek: () => [],
      teardown: () => {},
    }
    const onQuery = { submit: vi.fn() }
    const machine = new OnSubmitStateMachine({
      cmdQueue: cmdQueue as any,
      onQuery: onQuery as any,
    })
    machine.submit('hello world')
    expect(cmdQueue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('parse /-prefixed input as command', () => {
    const cmdQueue = { enqueue: vi.fn(), drain: () => [], peek: () => [], teardown: () => {} }
    const onQuery = { submit: vi.fn() }
    const machine = new OnSubmitStateMachine({
      cmdQueue: cmdQueue as any,
      onQuery: onQuery as any,
    })
    machine.submit('/help')
    expect(cmdQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ value: '/help', mode: 'slash' })
    )
  })
})

describe('OnQueryStateMachine', () => {
  it('tryStart returns generation; concurrent call returns null', () => {
    const query = vi.fn(async function* () {})
    const machine = new OnQueryStateMachine({
      query: query as any,
      guard: { state: { tryStart: () => 1, end: () => true, isActive: () => false }, teardown: () => {} },
    })
    const gen = machine.start({})
    expect(gen).not.toBeNull()
  })
})

describe('OnQueryImplStateMachine', () => {
  it('concurrent loading of systemPrompt/userContext/systemContext', async () => {
    const sp = vi.fn(async () => 'system')
    const uc = vi.fn(async () => ({}))
    const sc = vi.fn(async () => ({}))
    const machine = new OnQueryImplStateMachine({
      getSystemPrompt: sp as any,
      getUserContext: uc as any,
      getSystemContext: sc as any,
    })
    const ctx = await machine.buildContext({})
    expect(ctx.systemPrompt).toBe('system')
    expect(sp).toHaveBeenCalledTimes(1)
    expect(uc).toHaveBeenCalledTimes(1)
    expect(sc).toHaveBeenCalledTimes(1)
  })
})
