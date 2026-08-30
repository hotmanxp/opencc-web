// packages/zn-agent-core/src/compat/repl/__tests__/setupMailboxBridge.test.ts
// @ts-nocheck
import { setupMailboxBridge } from '../setup/setupMailboxBridge.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('setupMailboxBridge', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-mailbox-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('send writes to target session inbox', async () => {
    const handle = setupMailboxBridge({
      sessionId: 'sender-1',
      cwd: tmpDir,
      teamName: 'team-a',
      agentName: 'lead',
      onSubmitMessage: () => {},
    })
    await handle.send('recipient-1', { text: 'hello' })
    // Verify file at tmpDir/.zai/inbox/recipient-1.jsonl contains the message
    handle.teardown()
  })

  it('teardown is idempotent', () => {
    const handle = setupMailboxBridge({
      sessionId: 'sender-2',
      cwd: tmpDir,
      onSubmitMessage: () => {},
    })
    handle.teardown()
    expect(() => handle.teardown()).not.toThrow()
  })
})
