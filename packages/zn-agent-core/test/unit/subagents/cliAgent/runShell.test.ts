import { describe, it, expect, vi } from 'vitest'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle } from '../../../../src/compat/subprocess/types.js'
import {
  createCliRunShell,
  toMessage,
} from '../../../../src/compat/subagents/cliAgent/runShell.js'
import type { SubagentEvent } from '../../../../src/compat/subagents/registry.js'

/** Minimal handle stub — runShell only touches `killTree` in these tests. */
function stubHandle(): SubprocessHandle & { killTree: ReturnType<typeof vi.fn> } {
  const killTree = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return {
    pid: 1234,
    stdin: {} as Writable,
    stdout: {} as Readable,
    stderr: {} as Readable,
    exitCode: Promise.resolve({ code: 0, signal: null }),
    killTree,
  }
}

async function collect(runId: string, shell: ReturnType<typeof createCliRunShell>): Promise<SubagentEvent[]> {
  const out: SubagentEvent[] = []
  for await (const ev of shell.run.events) out.push(ev)
  void runId
  return out
}

describe('subagents/cliAgent/runShell', () => {
  it('exposes events in push order and DONE after finalize', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    const pending = collect('run-1', shell)
    shell.internal.pushEvent({ type: 'assistant', text: 'hello' })
    shell.internal.pushEvent({ type: 'assistant', text: 'world' })
    shell.finalizeResult({ text: 'ok', stopReason: 'completed' })
    expect(await pending).toEqual([
      { type: 'assistant', text: 'hello' },
      { type: 'assistant', text: 'world' },
    ])
    expect((await shell.run.result).stopReason).toBe('completed')
  })

  it('finalizeResult is idempotent — first result wins', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    shell.finalizeResult({ text: 'first', stopReason: 'completed' })
    shell.finalizeResult({ text: 'second', stopReason: 'error', errorMessage: 'late' })
    const result = await shell.run.result
    expect(result).toEqual({ text: 'first', stopReason: 'completed' })
  })

  it('finalizeError rejects with an Error(message) and is idempotent', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    shell.finalizeError('boom')
    shell.finalizeError('ignored')
    await expect(shell.run.result).rejects.toThrow('boom')
  })

  it('finalizeResult after finalizeError is a no-op', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    shell.finalizeError('boom')
    shell.finalizeResult({ text: 'late', stopReason: 'completed' })
    await expect(shell.run.result).rejects.toThrow('boom')
  })

  it('cancel settles aborted, keeps empty text by default, and tree-kills once', async () => {
    const handle = stubHandle()
    const shell = createCliRunShell(handle, { id: 'run-1' })
    await shell.run.cancel()
    const result = await shell.run.result
    expect(result).toEqual({
      text: '',
      stopReason: 'aborted',
      errorMessage: 'cancelled by caller',
    })
    expect(handle.killTree).toHaveBeenCalledTimes(1)
  })

  it('cancel is idempotent — second call resolves immediately without double kill', async () => {
    const handle = stubHandle()
    const shell = createCliRunShell(handle, { id: 'run-1' })
    await shell.run.cancel()
    await shell.run.cancel()
    expect(handle.killTree).toHaveBeenCalledTimes(1)
  })

  it('cancel carries abortText partial output (dsh parity)', async () => {
    const handle = stubHandle()
    const shell = createCliRunShell(handle, {
      id: 'run-dsh',
      abortText: () => 'partial answer',
    })
    await shell.run.cancel()
    const result = await shell.run.result
    expect(result).toEqual({
      text: 'partial answer',
      stopReason: 'aborted',
      errorMessage: 'cancelled by caller',
    })
  })

  it('cancel ends the events iterator', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    const pending = collect('run-1', shell)
    shell.internal.pushEvent({ type: 'assistant', text: 'partial' })
    await shell.run.cancel()
    const events = await pending
    expect(events).toEqual([{ type: 'assistant', text: 'partial' }])
  })

  it('cancelled box flips on cancel (dsh bootstrap polls it)', async () => {
    const shell = createCliRunShell(stubHandle(), { id: 'run-1' })
    expect(shell.internal.cancelled.value).toBe(false)
    await shell.run.cancel()
    expect(shell.internal.cancelled.value).toBe(true)
  })

  it('toMessage normalizes Error and non-Error unknowns', () => {
    expect(toMessage(new Error('boom'))).toBe('boom')
    expect(toMessage('raw')).toBe('raw')
    expect(toMessage(42)).toBe('42')
  })
})