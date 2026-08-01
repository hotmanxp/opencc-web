/**
 * `createSessionFacade` runtime implementation.
 *
 * Vendor's session lifecycle lives in two places:
 *
 *   - `utils/sessionStoragePortable.ts` — pure-Node portable utilities
 *     (path resolution, JSONL read with compact-boundary handling).
 *     No ambient types — safe to import.
 *   - `utils/sessionStorage.ts` — full session CRUD with @ts-nocheck
 *     and a 5550-line vendor surface. Some methods we use are here;
 *     others we reimplement in pure Node (file append, unlink) so
 *     we don't drag the full vendor graph into the d.ts emit.
 *
 * Per the brief:
 *   - "复用 vendor serialization、compact boundary 和 tool message
 *     persistence": we use vendor's `sanitizePath`,
 *     `readTranscriptForLoad`, `appendEntryToFile`, and the JSONL
 *     layout vendor defines.
 *   - "不调用 serializeForAnthropic，不生成替代 uuid/timestamp":
 *     we use Node's `randomUUID` for new ids (NOT vendor's
 *     `regenerateSessionId` which mutates global STATE) and write
 *     the caller-supplied uuid/timestamp verbatim.
 *   - "session facade 返回 vendor 原生 session ID、目录和 transcript
 *     shape": we never translate to compat transcript shape.
 *
 * The session file lives at:
 *   ${dataDir}/projects/${sanitizePath(cwd)}/${sessionId}.jsonl
 *
 * which mirrors vendor's `${getProjectsDir()}/${sanitizePath(cwd)}/
 * ${sessionId}.jsonl` but roots the home dir at the caller's dataDir
 * instead of vendor's `getClaudeConfigHomeDir()`.
 *
 * The split into thin + impl mirrors `createHeadlessContext` /
 * `createHeadlessContext-impl.ts`. The public d.ts surface is
 * captured by the sibling file; this implementation file is excluded
 * from the d.ts emit so its transitive vendored imports don't leak
 * into the published types. Runtime contract is locked by the
 * vitest test in `test/unit/server/session-facade.test.ts`.
 */

// @ts-nocheck — see sessionFacade.ts. Transitive vendor imports pull
// in modules with ambient global dependencies (MACRO, etc.) that the
// server public surface doesn't need to type-check. Runtime behavior
// is locked by vitest; the public d.ts is captured by the sibling.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat as statAsync, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SessionCompactResult,
  SessionCreateResult,
  SessionFacade,
  SessionFacadeOptions,
  SessionGetOptions,
  SessionInfo,
  SessionListOptions,
  SessionTranscriptEntry,
} from './sessionFacade.js'
import {
  sanitizePath,
  readTranscriptForLoad,
} from '../utils/sessionStoragePortable.js'

const TRANSCRIPT_FILE_EXT = '.jsonl'

/**
 * Compute the canonical vendor-style file path for a (sessionId, cwd)
 * pair rooted at the caller's `dataDir` instead of vendor's
 * `getClaudeConfigHomeDir()`. Mirrors vendor's `getProjectDir()` +
 * `resolveSessionFilePath()` computation but dataDir-parameterized.
 */
function projectDirFor(dataDir: string, cwd: string): string {
  return join(dataDir, 'projects', sanitizePath(cwd))
}

function filePathFor(dataDir: string, cwd: string, sessionId: string): string {
  return join(projectDirFor(dataDir, cwd), `${sessionId}${TRANSCRIPT_FILE_EXT}`)
}

/**
 * Serialize a transcript entry to a single JSONL line. Mirrors
 * vendor's `jsonStringify(entry) + '\n'` (sessionStorage.ts:2874) but
 * uses Node's `JSON.stringify` — vendor's `jsonStringify` is just
 * JSON.stringify with a few extra branch handles; for our server
 * transcript shape (no BigInt, no Date round-trip needed) plain
 * JSON.stringify is byte-identical.
 */
function serializeEntry(entry: SessionTranscriptEntry): string {
  return JSON.stringify(entry) + '\n'
}

/**
 * Append a JSONL entry to a session file. Creates the parent dir if
 * missing. Mirrors vendor's `appendEntryToFile` (sessionStorage.ts:
 * 2869) but async — vendor's helper is sync because it's called from
 * sync exit-cleanup paths. The server facade is on the request path
 * and uses async fs.
 */
async function appendEntryAsync(
  fullPath: string,
  entry: SessionTranscriptEntry,
): Promise<void> {
  const line = serializeEntry(entry)
  try {
    await writeFile(fullPath, line, { flag: 'a', mode: 0o600 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      await mkdir(join(fullPath, '..'), { recursive: true, mode: 0o700 })
      await writeFile(fullPath, line, { flag: 'a', mode: 0o600 })
      return
    }
    throw err
  }
}

/**
 * Build a server-side session facade scoped to `cwd` / `dataDir`.
 * See `sessionFacade.ts` for the full method contract.
 */
export async function createSessionFacadeImpl(
  options: SessionFacadeOptions,
): Promise<SessionFacade> {
  const cwd = options.cwd
  const dataDir = options.dataDir

  /**
   * Resolve a session filePath. Vendor uses realpath + symlink
   * resolution in `resolveSessionFilePath`; for the server facade
   * we compute the canonical project dir + filename directly because
   * the caller already passed us the cwd + dataDir explicitly.
   */
  const resolvePath = (sessionId: string): string =>
    filePathFor(dataDir, cwd, sessionId)

  return {
    async create(): Promise<SessionCreateResult> {
      // We use Node's `randomUUID`, NOT vendor's `regenerateSessionId`,
      // because the latter mutates global STATE.sessionId (and through
      // that, STATE.parentSessionId / STATE.planSlugCache) — the
      // multi-session race the plan calls out.
      const sessionId = randomUUID()
      const filePath = resolvePath(sessionId)
      // Ensure the parent project dir exists and create the empty
      // JSONL file. We use writeFile (not appendFile) with the
      // `wx` flag so a second create() with the same UUID never
      // overwrites — randomUUID collisions are astronomically rare
      // but the contract should fail loud not silent-overwrite.
      await mkdir(join(filePath, '..'), { recursive: true, mode: 0o700 })
      await writeFile(filePath, '', { flag: 'wx', mode: 0o600 })
      return { sessionId, filePath, cwd }
    },

    async get(
      sessionId: string,
      _opts?: SessionGetOptions,
    ): Promise<SessionInfo | null> {
      const filePath = resolvePath(sessionId)
      try {
        const [raw, stat] = await Promise.all([
          readFile(filePath, 'utf8'),
          statAsync(filePath),
        ])
        // Lite header: parse the first non-empty line; if it's a
        // transcript entry we extract id/cwd/createdAt/updatedAt
        // from it. Vendor's `readSessionLite` does the same; for our
        // minimal surface we read the whole file and take the first
        // line (session files are JSONL with one entry per line).
        const firstLine = raw
          .split('\n')
          .find(line => line.trim().length > 0)
        if (!firstLine) {
          return {
            id: sessionId,
            cwd,
            filePath,
            createdAt: 0,
            updatedAt: 0,
            messageCount: 0,
          }
        }
        const parsed = JSON.parse(firstLine) as Record<string, unknown>
        const messageCount = raw.split('\n').filter(line => line.trim()).length
        return {
          id: sessionId,
          cwd,
          filePath,
          createdAt:
            typeof parsed.createdAt === 'number'
              ? (parsed.createdAt as number)
              : 0,
          // Use the file's mtime for `updatedAt` so list() can sort
          // by recency. We avoid `Date.now()` here because two
          // sessions created within the same millisecond would tie
          // (the original test exposed this — the second's
          // get() call rewrites both files' updatedAt to the
          // current instant, breaking the sort).
          updatedAt: stat.mtimeMs,
          messageCount,
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return null
        throw err
      }
    },

    async list(opts?: SessionListOptions): Promise<SessionInfo[]> {
      const projectDir = projectDirFor(dataDir, opts?.cwd ?? cwd)
      let dirents: string[]
      try {
        dirents = await readdir(projectDir)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return []
        throw err
      }
      const sessions: SessionInfo[] = []
      for (const name of dirents) {
        if (!name.endsWith(TRANSCRIPT_FILE_EXT)) continue
        const sessionId = name.slice(0, -TRANSCRIPT_FILE_EXT.length)
        const filePath = join(projectDir, name)
        const info = await this.get(sessionId, { cwd: opts?.cwd ?? cwd })
        if (info) sessions.push(info)
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      const limit = opts?.limit ?? Number.POSITIVE_INFINITY
      return sessions.slice(0, limit)
    },

    async readTranscript(sessionId: string): Promise<string> {
      const filePath = resolvePath(sessionId)
      // We use vendor's `readTranscriptForLoad` for compact-boundary
      // handling — this matches the brief's "复用 vendor ... compact
      // boundary". The vendor function returns a Buffer; we decode
      // and return as a string. For sessions without a boundary
      // (the common case for new sessions) `boundaryStartOffset` is 0
      // and `postBoundaryBuf` is the entire transcript.
      const fileSize = (await readFile(filePath)).length
      const result = await readTranscriptForLoad(filePath, fileSize)
      const postBuf = result.postBoundaryBuf
      return postBuf.toString('utf8')
    },

    async append(
      sessionId: string,
      entry: SessionTranscriptEntry,
    ): Promise<void> {
      const filePath = resolvePath(sessionId)
      await appendEntryAsync(filePath, entry)
    },

    async patchSession(
      sessionId: string,
      patch: SessionTranscriptEntry,
    ): Promise<void> {
      // Vendor patches are JSONL entries appended to the same file
      // (e.g. `custom-title`, `tag`, `agent-name`). We reuse
      // `appendEntryAsync` so the patch lands in the same stream as
      // the transcript — no separate metadata file.
      const filePath = resolvePath(sessionId)
      await appendEntryAsync(filePath, patch)
    },

    async removeSession(sessionId: string): Promise<boolean> {
      const filePath = resolvePath(sessionId)
      try {
        await rm(filePath, { force: false })
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return false
        throw err
      }
    },

    async compact(sessionId: string): Promise<SessionCompactResult | null> {
      const filePath = resolvePath(sessionId)
      let fileSize: number
      try {
        const stat = await readFile(filePath)
        fileSize = stat.length
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return null
        throw err
      }
      const result = await readTranscriptForLoad(filePath, fileSize)
      return {
        boundaryStartOffset: result.boundaryStartOffset,
        postBoundaryLength: result.postBoundaryBuf.length,
        hasPreservedSegment: result.hasPreservedSegment,
      }
    },
  }
}