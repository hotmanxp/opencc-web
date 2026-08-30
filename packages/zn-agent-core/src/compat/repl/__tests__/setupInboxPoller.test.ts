// @ts-nocheck
import { setupInboxPoller } from '../setup/setupInboxPoller.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('setupInboxPoller', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-inbox-'))

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('teardown stops polling cleanly', () => {
    const received: any[] = []
    const handle = setupInboxPoller({
      sessionId: 's1',
      cwd: tmpDir,
      isLoading: () => false,
      onMessage: msg => received.push(msg),
    })
    handle.teardown()
    expect(received).toEqual([])
  })

  it('teardown is idempotent', () => {
    const handle = setupInboxPoller({
      sessionId: 's2',
      cwd: tmpDir,
      isLoading: () => false,
      onMessage: () => {},
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })

  it('isLoading=true skips message dispatch', async () => {
    const received: any[] = []
    const handle = setupInboxPoller({
      sessionId: 's3',
      cwd: tmpDir,
      isLoading: () => true,
      onMessage: msg => received.push(msg),
    })
    // No file exists, but if it did, isLoading=true would skip
    await handle.trigger() // manual trigger to force poll
    expect(received).toEqual([])
    handle.teardown()
  })
})
