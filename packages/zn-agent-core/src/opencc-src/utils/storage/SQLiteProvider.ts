import { join } from 'path'
import { existsSync, mkdirSync, openSync, readSync, closeSync, unlinkSync } from 'fs'
import type { Entity, Relation, SemanticSummary, KnowledgeGraph } from '../knowledgeGraph.ts'
import { registerCleanup } from '../cleanupRegistry.ts'

/**
 * SQLite Storage Provider for Knowledge Graph.
 * Provides ACID-compliant, high-performance relational storage.
 * Runtime-safe: Falls back to no-op if bun:sqlite is unavailable (e.g. on Node.js).
 */
export class SQLiteProvider {
  private db: any = null
  private dbPath: string
  private isInitialized = false

  constructor(projectDir: string) {
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
    this.dbPath = join(projectDir, 'knowledge.db')
    
    // Ensure connection is closed on process exit
    registerCleanup(async () => this.close())
  }

  public get isReady(): boolean {
    return this.isInitialized && this.db !== null
  }

  public async init(): Promise<void> {
    if (this.isInitialized && this.db) return

    // Runtime check: bun:sqlite is only available in Bun
    if (typeof Bun === 'undefined') {
      this.isInitialized = true
      return
    }

    try {
      // Dynamic import to prevent Node.js from failing during bundle load
      const { Database } = await import('bun:sqlite')

      // Empty file or non-SQLite header (e.g. corrupted disk write) → remove
      // before opening. Without this, bun:sqlite opens lazily and the first
      // PRAGMA below throws SQLITE_NOTADB, which we currently surface as a
      // console.error even though selfHeal() recovers cleanly.
      if (existsSync(this.dbPath) && !this.hasValidSQLiteHeader()) {
        for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
          try { unlinkSync(f) } catch {}
        }
      }

      this.db = new Database(this.dbPath)
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA foreign_keys = ON;')
      this.createTables()
      this.isInitialized = true
    } catch (e) {
      if (!String(e).includes('disk I/O error')) {
        console.error(`Failed to initialize SQLite database at ${this.dbPath}:`, e)
      }
      await this.selfHeal()
    }
  }

  /**
   * True if the file at dbPath begins with the 16-byte SQLite header
   * ("SQLite format 3\0"). Returns false for missing, empty, or truncated
   * files — used to detect corrupt disk state before bun:sqlite lazy-opens
   * and throws SQLITE_NOTADB on the first PRAGMA.
   */
  private hasValidSQLiteHeader(): boolean {
    let fd: number | undefined
    try {
      fd = openSync(this.dbPath, 'r')
      const buf = Buffer.alloc(16)
      const bytesRead = readSync(fd, buf, 0, 16, 0)
      if (bytesRead < 16) return false
      return buf.toString('utf-8', 0, 15) === 'SQLite format 3'
    } catch {
      return false
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
      }
    }
  }

  private async selfHeal(): Promise<void> {
    try {
      this.close()
      // Clean up main DB and side-car files to prevent reattaching to stale WAL/SHM
      const sidecars = [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]
      for (const file of sidecars) {
        if (existsSync(file)) {
          try { unlinkSync(file) } catch {}
        }
      }
      
      if (typeof Bun !== 'undefined') {
        const { Database } = await import('bun:sqlite')
        this.db = new Database(this.dbPath)
        this.db.exec('PRAGMA journal_mode = WAL;')
        this.db.exec('PRAGMA foreign_keys = ON;')
        this.createTables()
      }
      this.isInitialized = true
    } catch (e) {
      console.warn(`Critical SQLite failure during self-heal at ${this.dbPath}. Falling back to JSON:`, e)
      this.isInitialized = true
      this.db = null
    }
  }

  private createTables(): void {
    if (!this.db) return

    const statements = [
      `CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        attributes TEXT,
        last_updated INTEGER
      );`,
      `CREATE TABLE IF NOT EXISTS relations (
        source_id TEXT,
        target_id TEXT,
        type TEXT,
        PRIMARY KEY (source_id, target_id, type),
        FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
      );`,
      `CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        content TEXT,
        keywords TEXT,
        timestamp INTEGER
      );`,
      `CREATE TABLE IF NOT EXISTS rules (
        content TEXT PRIMARY KEY,
        timestamp INTEGER
      );`,
      `CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );`
    ]

    for (const stmt of statements) {
      this.db.exec(stmt)
    }
  }

  /**
   * Persists the Knowledge Graph using an incremental merge strategy for all tables.
   */
  public saveGraph(graph: KnowledgeGraph): void {
    // Note: init() must be called and awaited before saveGraph
    if (!this.db) return

    try {
      this.db.transaction(() => {
        const upsertEntity = this.db!.prepare(`
          INSERT INTO entities (id, type, name, attributes, last_updated) 
          VALUES ($id, $type, $name, $attributes, $last_updated)
          ON CONFLICT(id) DO UPDATE SET 
            type=excluded.type, 
            name=excluded.name, 
            attributes=excluded.attributes, 
            last_updated=excluded.last_updated
        `)
        
        const upsertSummary = this.db!.prepare(`
          INSERT INTO summaries (id, content, keywords, timestamp) 
          VALUES ($id, $content, $keywords, $timestamp)
          ON CONFLICT(id) DO UPDATE SET 
            content=excluded.content, 
            keywords=excluded.keywords, 
            timestamp=excluded.timestamp
        `)

        const upsertRelation = this.db!.prepare(`
          INSERT INTO relations (source_id, target_id, type) 
          VALUES ($source_id, $target_id, $type)
          ON CONFLICT(source_id, target_id, type) DO NOTHING
        `)

        const upsertRule = this.db!.prepare(`
          INSERT INTO rules (content, timestamp) 
          VALUES ($content, $timestamp)
          ON CONFLICT(content) DO UPDATE SET 
            timestamp=excluded.timestamp
        `)

        for (const entity of Object.values(graph.entities)) {
          upsertEntity.run({
            $id: entity.id,
            $type: entity.type,
            $name: entity.name,
            $attributes: JSON.stringify(entity.attributes),
            $last_updated: graph.lastUpdateTime
          })
        }

        for (const rel of graph.relations) {
          upsertRelation.run({
            $source_id: rel.sourceId,
            $target_id: rel.targetId,
            $type: rel.type
          })
        }

        for (const summary of graph.summaries) {
          upsertSummary.run({
            $id: summary.id,
            $content: summary.content,
            $keywords: JSON.stringify(summary.keywords),
            $timestamp: summary.timestamp
          })
        }

        for (const rule of graph.rules) {
          upsertRule.run({
            $content: rule,
            $timestamp: Date.now()
          })
        }

        this.db!.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)')
          .run('last_update_time', graph.lastUpdateTime.toString())
      })()
    } catch (e) {
      console.error('Failed to save graph to SQLite:', e)
    }
  }

  public loadGraph(): KnowledgeGraph | null {
    // Note: init() must be called and awaited before loadGraph
    if (!this.db) return null

    try {
      const entitiesRaw = this.db.query('SELECT * FROM entities').all() as any[]
      const summariesRaw = this.db.query('SELECT * FROM summaries').all() as any[]
      
      if (entitiesRaw.length === 0 && summariesRaw.length === 0) {
        return null
      }

      const relationsRaw = this.db.query('SELECT * FROM relations').all() as any[]
      const rulesRaw = this.db.query('SELECT * FROM rules').all() as any[]
      const meta = this.db.query('SELECT value FROM sync_meta WHERE key = "last_update_time"').get() as any

      const entities: Record<string, Entity> = {}
      for (const row of entitiesRaw) {
        entities[row.id] = {
          id: row.id,
          type: row.type,
          name: row.name,
          attributes: JSON.parse(row.attributes)
        }
      }

      const relations: Relation[] = relationsRaw.map((row: any) => ({
        sourceId: row.source_id,
        targetId: row.target_id,
        type: row.type
      }))

      const summaries: SemanticSummary[] = summariesRaw.map((row: any) => ({
        id: row.id,
        content: row.content,
        keywords: JSON.parse(row.keywords),
        timestamp: row.timestamp
      }))

      const rules: string[] = rulesRaw.map((row: any) => row.content)

      return {
        entities,
        relations,
        summaries,
        rules,
        lastUpdateTime: meta ? parseInt(meta.value) : Date.now()
      }
    } catch (e) {
      return null
    }
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {}
      this.db = null
    }
    this.isInitialized = false
  }
}
