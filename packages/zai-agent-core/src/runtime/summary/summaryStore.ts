/**
 * runtime/summary/summaryStore.ts — persistent storage for tool-use summaries.
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-e-step-limit-design.md
 *
 * `SummaryStore` provides per-transcriptId `get(toolUseId) / set(record)`
 * access to `ToolSummaryRecord`s.
 *
 * Storage layout (§2.2):
 *   <dataDir>/summaries/<transcriptId>.json
 *     {
 *       schema: 'tool-summary/v1',
 *       records: ToolSummaryRecord[]
 *     }
 *
 * - `dataDir` resolves from `ZAI_DATA_DIR` env (falls back to `~/.zai`),
 *   matching the pattern used by `runtime/compact/log-event.ts`.
 * - Cross-process safety: writes use a sync file-based lock via atomic
 *   mkdir on a `.lock` directory sibling to the data file. Same idea as
 *   `proper-lockfile` but synchronous so `set()` returns only after the
 *   data has been written + released (spec §3 行为 8: "写时 fsync + lock").
 * - Atomic write: temp file → fsync → rename. Avoids partial-write
 *   corruption if the process dies mid-write.
 * - In-memory cache: the store keeps a `Map<toolUseId, ToolSummaryRecord>`
 *   that is hydrated lazily on first access.
 * - Idempotent: writing the same `toolUseId` twice replaces the previous
 *   record (later wins).
 * - Decoupled from `TranscriptStore` (spec §1.3 + §6.1): no imports from
 *   `transcript/**`.
 * - §2.4 error contract: storage IO errors are silent no-op. Failed writes
 *   do NOT pollute the in-memory map (so subsequent `get` returns
 *   undefined, consistent with "never persisted").
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  closeSync,
  fsyncSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// ---- public types ----------------------------------------------------------

export interface ToolSummaryRecord {
  toolUseId: string
  /** 1-2 sentence summary; empty string indicates a fallback record. */
  summary: string
  /** Unix epoch ms when the summary was generated. */
  generatedAt: number
  /** Model alias that produced the summary (e.g. 'haiku', 'claude-haiku-4-5'); 'fallback' on error. */
  modelUsed: string
}

export interface SummaryStore {
  get(toolUseId: string): ToolSummaryRecord | undefined
  set(record: ToolSummaryRecord): void
}

export interface SummaryStoreOptions {
  /**
   * Override the parent directory where `<transcriptId>.json` files live.
   * Used by tests to force IO failures. Defaults to
   * `<dataDir>/summaries`.
   */
  summariesDir?: string
}

// ---- constants -------------------------------------------------------------

export const TOOL_SUMMARY_SCHEMA = 'tool-summary/v1' as const

const LOCK_RETRY_DELAY_MS = 10
const LOCK_MAX_RETRIES = 50 // ~500ms worst case

// ---- module state ----------------------------------------------------------

/** Resolve `<dataDir>` from env, mirroring `runtime/compact/log-event.ts`. */
function resolveDataDir(): string {
  return process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

function defaultSummariesDir(): string {
  return join(resolveDataDir(), 'summaries')
}

/**
 * Module-level cache: `<transcriptId>::<summariesDir>` -> SummaryStore
 * instance. Caching ensures the in-memory state is consistent across
 * calls within a process.
 */
const storeCache = new Map<string, SummaryStore>()

/**
 * Reset the module-level store cache. Test-only — production code should
 * never need to clear this (each `transcriptId` gets a stable store).
 */
export function __resetSummaryStoreCacheForTests(): void {
  storeCache.clear()
}

// ---- public factory --------------------------------------------------------

/**
 * Get (or create) a `SummaryStore` for the given transcript ID.
 *
 * The store is created lazily on first call and cached for subsequent
 * calls with the same `transcriptId`. The first `get` or `set` hydrates
 * the in-memory map from `<summariesDir>/<transcriptId>.json` if it exists.
 *
 * @param transcriptId  The transcript/session ID whose summaries to manage.
 * @param opts          Optional overrides (mainly for tests).
 */
export function getSummaryStore(
  transcriptId: string,
  opts?: SummaryStoreOptions,
): SummaryStore {
  const key = `${transcriptId}::${opts?.summariesDir ?? ''}`
  const cached = storeCache.get(key)
  if (cached) return cached

  const summariesDir = opts?.summariesDir ?? defaultSummariesDir()
  const store = createSummaryStore(transcriptId, summariesDir)
  storeCache.set(key, store)
  return store
}

// ---- implementation --------------------------------------------------------

interface PersistedFile {
  schema: string
  records: ToolSummaryRecord[]
}

function createSummaryStore(
  transcriptId: string,
  summariesDir: string,
): SummaryStore {
  const filePath = join(summariesDir, `${transcriptId}.json`)
  const lockPath = `${filePath}.lock`
  const records = new Map<string, ToolSummaryRecord>()
  let hydrated = false
  let hydrateFailed = false

  function hydrateOnce(): void {
    if (hydrated || hydrateFailed) return
    // Set `hydrated` first so a failed read doesn't loop on every call.
    hydrated = true
    if (!existsSync(filePath)) return
    try {
      const raw = readFileSync(filePath, 'utf-8')
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<PersistedFile>
      if (parsed && Array.isArray(parsed.records)) {
        for (const rec of parsed.records) {
          if (rec && typeof rec.toolUseId === 'string') {
            records.set(rec.toolUseId, rec)
          }
        }
      }
    } catch {
      // §2.4: storage IO errors are silent no-op. Mark as failed so the
      // map stays empty rather than re-attempting every get().
      hydrateFailed = true
      records.clear()
    }
  }

  /**
   * Acquire a process-local file lock synchronously. Uses atomic mkdir;
   * on POSIX `mkdir` of an existing path fails with EEXIST, giving us
   * mutual exclusion across processes. Returns a release function.
   */
  function acquireLock(): () => void {
    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
      try {
        mkdirSync(lockPath)
        return () => {
          // Lock is a directory (mkdir), so release uses rmdirSync.
          try {
            rmdirSync(lockPath)
          } catch {
            // ignore — another process may have removed it
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') {
          // Locking itself failed (perm denied, etc.). Surface as a
          // failed persist; the caller will swallow the error per §2.4.
          throw err
        }
        // busy — brief sync wait, then retry
        const until = Date.now() + LOCK_RETRY_DELAY_MS
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
    throw new Error(`SummaryStore: lock acquisition timed out for ${lockPath}`)
  }

  /**
   * Synchronous persist: write + fsync. Returns `true` on success,
   * `false` on any IO error (§2.4: silent no-op).
   *
   * Uses an atomic temp-file + rename pattern to avoid partial writes
   * corrupting the persisted store if the process dies mid-write.
   */
  function persistSync(): boolean {
    const payload: PersistedFile = {
      schema: TOOL_SUMMARY_SCHEMA,
      records: Array.from(records.values()),
    }
    const serialized = JSON.stringify(payload, null, 2)
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    let release: (() => void) | null = null
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      release = acquireLock()

      // Write to tmp first, fsync, then rename onto the real path.
      const fd = openSync(tmpPath, 'w')
      try {
        writeSync(fd, serialized, 0, 'utf-8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const fs = require('node:fs') as typeof import('node:fs')
      fs.renameSync(tmpPath, filePath)
      return true
    } catch {
      // Silent no-op per §2.4.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
      return false
    } finally {
      if (release) release()
    }
  }

  return {
    get(toolUseId: string): ToolSummaryRecord | undefined {
      hydrateOnce()
      return records.get(toolUseId)
    },

    set(record: ToolSummaryRecord): void {
      if (!record || typeof record.toolUseId !== 'string') return
      hydrateOnce()

      // Optimistic: place into in-memory map first so `get` sees the
      // latest value immediately. If persist fails we roll back.
      const previous = records.get(record.toolUseId)
      records.set(record.toolUseId, record)

      // Synchronous persist so the file exists by the time `set` returns.
      // Spec §3 行为 8: "写时 fsync + lock".
      const ok = persistSync()
      if (!ok) {
        // Roll back: leave the map consistent with what was actually
        // persisted to disk. The test "write failure does not throw
        // (silent no-op)" relies on this — the failed record must not
        // appear in subsequent `get` calls.
        if (previous) {
          records.set(record.toolUseId, previous)
        } else {
          records.delete(record.toolUseId)
        }
      }
    },
  }
}

// ---- re-exports for tests --------------------------------------------------

/**
 * Test-only helpers.
 */
export const __testing = {
  defaultSummariesDir,
  resolveDataDir,
  __resetSummaryStoreCacheForTests,
}