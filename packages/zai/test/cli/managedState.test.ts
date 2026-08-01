import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { managedStatePath, readManagedState, writeManagedState } from '../../src/cli/managedState.js'

let dataDir: string

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'zai-state-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

describe('managedState', () => {
  it('returns null when file does not exist', async () => {
    expect(await readManagedState(dataDir)).toBeNull()
  })

  it('round-trips state via writeManagedState + readManagedState', async () => {
    await writeManagedState({
      supervisorPid: 1234, state: 'running',
      childPid: 5678, startedAt: '2026-08-01T00:00:00Z',
      restarts: 0, lastError: null,
    }, dataDir)
    const got = await readManagedState(dataDir)
    expect(got?.supervisorPid).toBe(1234)
    expect(got?.childPid).toBe(5678)
  })

  it('partial patch merges with existing state', async () => {
    await writeManagedState({ supervisorPid: 1, state: 'starting', childPid: null, startedAt: 't', restarts: 0, lastError: null }, dataDir)
    await writeManagedState({ restarts: 3 }, dataDir)
    const got = await readManagedState(dataDir)
    expect(got?.restarts).toBe(3)
    expect(got?.supervisorPid).toBe(1)
  })

  it('managedStatePath defaults to ~/.zai/state/managed.json', () => {
    expect(managedStatePath()).toContain('managed.json')
  })
})
