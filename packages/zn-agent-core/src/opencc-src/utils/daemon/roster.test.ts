/**
 * Tests for the bg daemon roster persistence.
 *
 * The roster is the on-disk record of every known bg daemon job, written
 * atomically (tmp file in same dir → rename) and quarantined on parse
 * failure rather than crashed on. updateRoster serializes concurrent
 * callers via a module-level promise chain so two parallel jobs in the
 * same supervisor never clobber each other.
 *
 * Tests use `mkdtempSync` + an explicit `{path}` option on every function
 * to avoid touching the real `~/.claude/roster.json`.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T4
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {readdir, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  ROSTER_VERSION,
  loadRoster,
  saveRoster,
  updateRoster,
  type Roster,
} from './roster.ts'
import {JobShortIdSchema} from './protocol.ts'

// ---------- Helpers ----------

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'roster-'))
}

/**
 * Tests must place roster files under a `.claude` subdir so they
 * satisfy the path-root assertion in `atomicWriteFile`. This helper
 * returns a fresh `.claude` directory under a temp parent.
 */
function freshClaudeDir(): string {
  const parent = freshDir()
  const claude = join(parent, '.claude')
  mkdirSync(claude, {recursive: true})
  return claude
}

const sampleJob = (short: string, sessionId: string) => ({
  short: JobShortIdSchema.parse(short),
  nonce: short,
  sessionId,
  source: 'shell' as const,
  cwd: `/tmp/${sessionId}`,
  createdAt: 100,
  isolation: 'none' as const,
})

// ---------- Setup / teardown ----------

const dirs: string[] = []

beforeEach(() => {
  // Reset the module-level update chain by re-importing is overkill;
  // each test uses a fresh dir + a fresh initial save so chain order
  // is the call order. The chain itself never carries state across
  // tests because errors don't poison it.
})

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, {recursive: true, force: true})
    } catch {
      // best-effort
    }
  }
  dirs.length = 0
})

function trackDir(d: string): string {
  dirs.push(d)
  return d
}

// ---------- Round-trip ----------

describe('saveRoster + loadRoster round-trip', () => {
  test('saves and loads a roster with one job', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    const r: Roster = {
      version: ROSTER_VERSION,
      updatedAt: 100,
      supervisorPid: 999,
      jobs: {abcd1234: sampleJob('abcd1234', 's1')},
    }
    await saveRoster(r, {path})
    const loaded = await loadRoster({path})
    expect(loaded).toEqual(r)
  })

  test('saves and loads a roster with multiple jobs', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    const r: Roster = {
      version: ROSTER_VERSION,
      updatedAt: 200,
      supervisorPid: 7,
      jobs: {
        aaaa1111: sampleJob('aaaa1111', 'sa'),
        bbbb2222: sampleJob('bbbb2222', 'sb'),
        cccc3333: sampleJob('cccc3333', 'sc'),
      },
    }
    await saveRoster(r, {path})
    const loaded = await loadRoster({path})
    expect(Object.keys(loaded.jobs).sort()).toEqual([
      'aaaa1111',
      'bbbb2222',
      'cccc3333',
    ])
    expect(loaded.supervisorPid).toBe(7)
  })

  test('loadRoster on missing file returns empty roster', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    const r = await loadRoster({path})
    expect(r.version).toBe(ROSTER_VERSION)
    expect(r.jobs).toEqual({})
    expect(r.supervisorPid).toBeGreaterThan(0)
    expect(r.updatedAt).toBeGreaterThan(0)
  })
})

// ---------- Corrupt file handling ----------

describe('corrupt file handling', () => {
  test('quarantines a file with invalid JSON', async () => {
    const dir = trackDir(freshDir())
    const path = join(dir, 'roster.json')
    writeFileSync(path, '{ not valid json', 'utf8')

    const r = await loadRoster({path})
    expect(r.jobs).toEqual({})

    const files = readdirSync(dir)
    const hasCorrupt = files.some(f => f.startsWith('roster.json.corrupt.'))
    expect(hasCorrupt).toBe(true)
    // The original file is gone (renamed to .corrupt.<ts>)
    expect(files).not.toContain('roster.json')
  })

  test('quarantines a file that fails zod validation', async () => {
    const dir = trackDir(freshDir())
    const path = join(dir, 'roster.json')
    // version: 999 is not ROSTER_VERSION=1
    writeFileSync(path, JSON.stringify({version: 999, jobs: {}}), 'utf8')

    const r = await loadRoster({path})
    expect(r.jobs).toEqual({})

    const files = readdirSync(dir)
    expect(files.some(f => f.startsWith('roster.json.corrupt.'))).toBe(true)
    expect(files).not.toContain('roster.json')
  })

  test('quarantines a file with wrong job shape', async () => {
    const dir = trackDir(freshDir())
    const path = join(dir, 'roster.json')
    // valid envelope, but jobs.k is not a valid JobRecord
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        supervisorPid: 1,
        jobs: {k: {this: 'is not a JobRecord'}},
      }),
      'utf8',
    )

    const r = await loadRoster({path})
    expect(r.jobs).toEqual({})
    expect(readdirSync(dir).some(f => f.startsWith('roster.json.corrupt.'))).toBe(
      true,
    )
  })

  test('quarantines an empty (zero-byte) file', async () => {
    const dir = trackDir(freshDir())
    const path = join(dir, 'roster.json')
    await writeFile(path, '', 'utf8')
    const r = await loadRoster({path})
    expect(r.jobs).toEqual({})
    const files = await readdir(dir)
    expect(files.some(f => f.includes('.corrupt.'))).toBe(true)
  })

  test('silent flag suppresses the stderr warning on parse failure', async () => {
    const dir = trackDir(freshDir())
    const path = join(dir, 'roster.json')
    writeFileSync(path, 'not json at all', 'utf8')

    // Capture stderr.
    const original = process.stderr.write.bind(process.stderr)
    const stderrWrites: string[] = []
    ;(process.stderr as {write: (s: string) => boolean}).write = (
      chunk: string,
    ) => {
      stderrWrites.push(String(chunk))
      return true
    }

    try {
      // The first call quarantines the file; the second sees a missing file
      // and returns empty silently. We assert silent: true emits no warnings
      // on either path.
      await loadRoster({path, silent: true})
      const warnMsgs = stderrWrites.filter(s => s.includes('roster:'))
      expect(warnMsgs).toEqual([])
    } finally {
      ;(process.stderr as {write: typeof original}).write = original
    }
  })
})

// ---------- File mode ----------

describe('file mode', () => {
  test('saveRoster writes file with mode 0o600', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    await saveRoster(
      {version: ROSTER_VERSION, updatedAt: 0, supervisorPid: 0, jobs: {}},
      {path},
    )
    const st = await stat(path)
    // Mask off file-type bits; we only care about permission bits.
    expect(st.mode & 0o777).toBe(0o600)
  })

  test('saveRoster creates target file when parent exists', async () => {
    const dir = trackDir(freshDir())
    const claudeDir = join(dir, '.claude')
    mkdirSync(claudeDir, {recursive: true})
    const path = join(claudeDir, 'roster.json')
    await saveRoster(
      {version: ROSTER_VERSION, updatedAt: 0, supervisorPid: 0, jobs: {}},
      {path},
    )
    const files = readdirSync(claudeDir)
    expect(files).toContain('roster.json')
  })

  test('saveRoster refuses paths outside ~/.claude', async () => {
    const dir = trackDir(freshDir())
    const badPath = join(dir, 'evil.json')
    await expect(() =>
      saveRoster(
        {version: ROSTER_VERSION, updatedAt: 0, supervisorPid: 0, jobs: {}},
        {path: badPath},
      ),
    ).toThrow(/outside.*\.claude/i)
  })
})

// ---------- updateRoster serialization ----------

describe('updateRoster serialization', () => {
  test('serializes concurrent updates (no lost writes)', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    const initial: Roster = {
      version: ROSTER_VERSION,
      updatedAt: 0,
      supervisorPid: 999,
      jobs: {},
    }
    await saveRoster(initial, {path})

    // Fire 10 concurrent updates; each adds a unique job.
    const updates = Array.from({length: 10}, (_, i) =>
      updateRoster(
        r => {
          const short = JobShortIdSchema.parse(
            i.toString(16).padStart(8, '0'),
          )
          r.jobs[short] = sampleJob(short, `s${i}`)
          return r
        },
        {path},
      ),
    )
    await Promise.all(updates)

    const final = await loadRoster({path})
    expect(Object.keys(final.jobs).length).toBe(10)
    for (let i = 0; i < 10; i++) {
      const short = JobShortIdSchema.parse(
        i.toString(16).padStart(8, '0'),
      )
      expect(final.jobs[short]?.sessionId).toBe(`s${i}`)
    }
  })

  test('stamps supervisorPid and updatedAt on each update', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')

    await updateRoster(r => r, {path})
    const loaded = await loadRoster({path})
    expect(loaded.supervisorPid).toBe(process.pid)
    expect(loaded.updatedAt).toBeGreaterThan(0)
    expect(loaded.version).toBe(ROSTER_VERSION)
  })

  test('preserves caller-set supervisorPid if provided', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    await updateRoster(
      r => ({
        ...r,
        supervisorPid: 4242,
      }),
      {path},
    )
    const loaded = await loadRoster({path})
    expect(loaded.supervisorPid).toBe(4242)
  })

  test('an update failure does not poison subsequent updates', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')

    await expect(
      updateRoster(
        () => {
          throw new Error('boom')
        },
        {path},
      ),
    ).rejects.toThrow()

    // Subsequent update should still work.
    const r = await updateRoster(r => r, {path})
    expect(r.version).toBe(ROSTER_VERSION)
    expect(r.jobs).toEqual({})

    const loaded = await loadRoster({path})
    expect(loaded.jobs).toEqual({})
  })

  test('async transforms are awaited', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')

    const r = await updateRoster(
      async roster => {
        await new Promise(resolve => setTimeout(resolve, 5))
        roster.jobs[JobShortIdSchema.parse('ffffffff')] = sampleJob('ffffffff', 'async')
        return roster
      },
      {path},
    )
    expect(r.jobs.ffffffff?.sessionId).toBe('async')

    const loaded = await loadRoster({path})
    expect(loaded.jobs.ffffffff?.sessionId).toBe('async')
  })
})

// ---------- Atomic write ----------

describe('atomic write', () => {
  test('saveRoster creates and renames a tmp file (no leftover on success)', async () => {
    const claudeDir = trackDir(freshClaudeDir())
    const path = join(claudeDir, 'roster.json')
    await saveRoster(
      {version: ROSTER_VERSION, updatedAt: 0, supervisorPid: 0, jobs: {}},
      {path},
    )
    const files = readdirSync(claudeDir)
    expect(files).toContain('roster.json')
    expect(files.some(f => f.includes('.tmp.'))).toBe(false)
  })
})