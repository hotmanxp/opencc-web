import { describe, expect, it, beforeEach, afterEach, afterAll } from 'bun:test'
import {
  addGlobalEntity,
  resetGlobalGraph,
  clearMemoryOnly,
  getGlobalGraph,
  initOrama
} from '../knowledgeGraph.js'
import { SQLiteProvider } from './SQLiteProvider.js'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectsDir } from '../envUtils.js'
import { sanitizePath } from '../sessionStoragePortable.js'

describe('SQLite Storage Layer', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = mkdtempSync(join(tmpdir(), 'opencc-sqlite-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  const cwd = process.cwd()

  beforeEach(() => {
    resetGlobalGraph()
  })

  afterAll(() => {
    resetGlobalGraph()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  it('persists data in SQLite database', async () => {
    const sqlitePath = join(getProjectsDir(), sanitizePath(cwd), 'knowledge.db')
    
    // 1. Add data
    await addGlobalEntity('tool', 'sqlite-test', { status: 'durable' })
    expect(existsSync(sqlitePath)).toBe(true)

    // 2. Simulate process restart (clear memory cache)
    clearMemoryOnly()

    // 3. Load should come from SQLite (hydrated by JSON)
    const graph = getGlobalGraph()
    const entity = Object.values(graph.entities).find(e => e.name === 'sqlite-test')
    expect(entity).toBeDefined()
    expect(entity?.attributes.status).toBe('durable')
  })

  it('self-heals SQLite from JSON if DB is deleted', async () => {
    const sqlitePath = join(getProjectsDir(), sanitizePath(cwd), 'knowledge.db')
    const jsonPath = join(getProjectsDir(), sanitizePath(cwd), 'knowledge_graph.json')

    // 1. Add data to both
    await addGlobalEntity('tool', 'self-heal-test', { val: 'safe' })
    expect(existsSync(sqlitePath)).toBe(true)
    expect(existsSync(jsonPath)).toBe(true)

    // 2. Delete SQLite DB but keep JSON
    clearMemoryOnly()
    rmSync(sqlitePath)
    expect(existsSync(sqlitePath)).toBe(false)

    // 3. Requesting the graph should trigger hydration from JSON into a NEW SQLite DB
    // In the async architecture, we must await initialization to trigger the rebuild.
    await initOrama(cwd)
    const graph = getGlobalGraph()
    const entity = Object.values(graph.entities).find(e => e.name === 'self-heal-test')
    expect(entity).toBeDefined()
    expect(entity?.attributes.val).toBe('safe')
    
    // 4. Verify SQLite was recreated
    expect(existsSync(sqlitePath)).toBe(true)
  })

  it('handles large transactions (Stress Test)', async () => {
    const count = 100
    const start = Date.now()

    // Add 100 entities sequentially (mutation queue)
    for (let i = 0; i < count; i++) {
      await addGlobalEntity('bulk', `item_${i}`, { index: String(i) })
    }

    const duration = Date.now() - start
    console.log(`Inserted ${count} items into SQLite+JSON+Orama in ${duration}ms`)

    clearMemoryOnly()
    const graph = getGlobalGraph()
    expect(Object.keys(graph.entities).length).toBe(count)
  })

  it('init() silently rebuilds a SQLite file whose header is corrupted (non-empty garbage)', async () => {
    // SQLiteProvider currently only unlinks EMPTY files before open.
    // A non-empty garbage file passes that check, then triggers
    // SQLITE_NOTADB on the first PRAGMA — which produces a console.error
    // even though selfHeal() recovers cleanly. This test pins the
    // expectation that init() should NOT emit that noise.
    const projectDir = join(configDir, 'corrupted-header-unit')
    mkdirSync(projectDir, { recursive: true })
    const sqlitePath = join(projectDir, 'knowledge.db')
    writeFileSync(sqlitePath, Buffer.from('NOT_SQLITE_BINARY'))

    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }

    try {
      const provider = new SQLiteProvider(projectDir)
      await provider.init()
      expect(provider.isReady).toBe(true)
    } finally {
      console.error = originalError
    }

    const noise = errors.filter(
      e =>
        e.includes('SQLITE_NOTADB') ||
        e.includes('file is not a database') ||
        e.includes('Failed to initialize SQLite'),
    )
    expect(noise).toEqual([])
  })
})
