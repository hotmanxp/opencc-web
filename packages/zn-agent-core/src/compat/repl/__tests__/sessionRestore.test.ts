// packages/zn-agent-core/src/compat/repl/__tests__/sessionRestore.test.ts
// @ts-nocheck
import { restoreSession } from '../sessionRestore.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('restoreSession', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'repl-p1-restore-'))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('restores messages from JSONL', async () => {
    const sessionId = 'restore-1'
    const jsonlPath = join(tmpDir, `${sessionId}.jsonl`)
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'session-meta', sessionId }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', parent_tool_use_id: null, session_id: sessionId }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, uuid: 'a1', parent_tool_use_id: null, session_id: sessionId }),
    ].join('\n'))

    const result = await restoreSession({
      sessionId,
      cwd: tmpDir,
      getAppState: () => ({}),
      setAppState: () => {},
    })

    expect(result.messages.length).toBe(2)
    expect(result.messages[0].type).toBe('user')
    expect(result.messages[1].type).toBe('assistant')
  })

  it('returns empty state for missing JSONL', async () => {
    const result = await restoreSession({
      sessionId: 'no-such-session',
      cwd: tmpDir,
      getAppState: () => ({}),
      setAppState: () => {},
    })
    expect(result.messages).toEqual([])
    expect(result.worktreeSession).toBeNull()
    expect(result.fileHistory).toEqual([])
  })
})
