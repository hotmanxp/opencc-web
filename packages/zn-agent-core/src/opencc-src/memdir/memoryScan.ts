/**
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import type { Dirent } from 'fs'
import { readdir, realpath } from 'fs/promises'
import { join, relative, resolve, sep } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import type { ReadFileRangeResult } from '../utils/readFileInRange.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30
const FRONTMATTER_MAX_BYTES = 64 * 1024
const MAX_DEPTH = 3
const HEADER_READ_CONCURRENCY = 8

type MemoryScanDirent = Pick<
  Dirent,
  'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink'
>

/**
 * Whether `target` is the memory dir or lives under it.
 *
 * Both sides are realpath'd before comparing. The base has to be resolved too:
 * on macOS a temp dir arrives as /var/folders/... while /var is itself a
 * symlink to /private/var, so comparing a raw base against a resolved target
 * makes every legitimate file look like it escapes.
 */
function isInside(memoryDirReal: string, target: string): boolean {
  if (target === memoryDirReal) return true
  const rel = relative(memoryDirReal, target)
  // `sep` guards against a sibling whose name merely starts with the memory
  // dir's name (/mem vs /memory); rel === '' is the equality case above.
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..'
}

type MemoryScanDependencies = {
  readdir: (dir: string) => Promise<MemoryScanDirent[]>
  readFileInRange: (
    filePath: string,
    offset: number,
    maxLines: number,
    maxBytes: number,
    signal: AbortSignal,
    options: { truncateOnByteLimit: true },
  ) => Promise<Pick<ReadFileRangeResult, 'content' | 'mtimeMs'>>
  /** Resolves a symlink for the containment check; injectable for tests. */
  realpath?: (path: string) => Promise<string>
}

type RankedMemoryHeader = {
  header: MemoryHeader
  order: number
}

const defaultDependencies: MemoryScanDependencies = {
  readdir: dir => readdir(dir, { withFileTypes: true }),
  realpath,
  readFileInRange,
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * Traversal is depth-bounded before opening child directories. Header reads
 * run through a small worker pool, and only the newest MAX_MEMORY_FILES
 * parsed headers are retained while scanning.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  return scanMemoryFilesWithDependencies(memoryDir, signal, defaultDependencies)
}

async function scanMemoryFilesWithDependencies(
  memoryDir: string,
  signal: AbortSignal,
  deps: MemoryScanDependencies,
): Promise<MemoryHeader[]> {
  try {
    signal.throwIfAborted()
    const controller = new AbortController()
    const internalSignal = controller.signal
    signal.addEventListener('abort', () => controller.abort(), { once: true })

    const topHeaders: RankedMemoryHeader[] = []
    const fileIterator = walkMarkdownFiles(
      memoryDir,
      internalSignal,
      deps,
    )[Symbol.asyncIterator]()
    let nextOrder = 0

    const workers = Array.from({ length: HEADER_READ_CONCURRENCY }, async () => {
      while (!internalSignal.aborted) {
        let next: IteratorResult<string>
        try {
          next = await fileIterator.next()
        } catch (error) {
          if (internalSignal.aborted) return
          controller.abort()
          throw error
        }
        if (next.done) return
        const order = nextOrder++

        try {
          const header = await readMemoryHeader(
            memoryDir,
            next.value,
            internalSignal,
            deps,
          )
          if (internalSignal.aborted) return
          insertNewestHeader(topHeaders, { header, order })
        } catch {
          if (internalSignal.aborted) return
        }
      }
    })

    await Promise.all(workers)
    return internalSignal.aborted ? [] : topHeaders.map(entry => entry.header)
  } catch {
    return []
  }
}

async function* walkMarkdownFiles(
  memoryDir: string,
  signal: AbortSignal,
  deps: MemoryScanDependencies,
): AsyncGenerator<string> {
  // Resolved once, up front: the containment check compares a symlink's
  // realpath against this, and comparing against the unresolved path rejects
  // every legitimate file whenever the memory dir sits under a symlinked
  // parent (macOS /var -> /private/var).
  const resolvePath = deps.realpath ?? realpath
  const memoryDirReal = await resolvePath(memoryDir).catch(() => resolve(memoryDir))
  const pendingDirs: Array<{
    absolutePath: string
    relativePath: string
    depth: number
  }> = [{ absolutePath: memoryDir, relativePath: '', depth: 0 }]

  while (pendingDirs.length > 0) {
    signal.throwIfAborted()
    const current = pendingDirs.pop()!
    let entries: MemoryScanDirent[]
    try {
      entries = await deps.readdir(current.absolutePath)
    } catch {
      continue
    }

    for (const entry of entries) {
      signal.throwIfAborted()
      const relativePath = current.relativePath
        ? join(current.relativePath, entry.name)
        : entry.name
      const absolutePath = join(memoryDir, relativePath)
      const isMarkdownMemoryFile =
        entry.name.endsWith('.md') && entry.name !== 'MEMORY.md'

      if (entry.isSymbolicLink()) {
        // A link was yielded unconditionally, so one pointing anywhere on disk
        // got read and injected into the model context — the memory dir is
        // where a user expects the scan to stay (cc-005). Resolve and require
        // containment; an internal link is still fine.
        if (!isMarkdownMemoryFile) continue
        let target: string
        try {
          target = await resolvePath(absolutePath)
        } catch {
          continue // dangling symlink — ignore
        }
        if (!isInside(memoryDirReal, target)) {
          logForDebugging(
            `[memoryScan] ignoring symlink outside the memory dir: ${relativePath}`,
          )
          continue
        }
        yield relativePath
        continue
      }

      if (entry.isDirectory()) {
        const nextDepth = current.depth + 1
        if (nextDepth < MAX_DEPTH) {
          pendingDirs.push({ absolutePath, relativePath, depth: nextDepth })
        }
        continue
      }

      if (entry.isFile() && isMarkdownMemoryFile) {
        yield relativePath
      }
    }
  }
}

async function readMemoryHeader(
  memoryDir: string,
  relativePath: string,
  signal: AbortSignal,
  deps: MemoryScanDependencies,
): Promise<MemoryHeader> {
  signal.throwIfAborted()
  const filePath = join(memoryDir, relativePath)
  const { content, mtimeMs } = await deps.readFileInRange(
    filePath,
    0,
    FRONTMATTER_MAX_LINES,
    FRONTMATTER_MAX_BYTES,
    signal,
    { truncateOnByteLimit: true },
  )
  const { frontmatter } = parseFrontmatter(content, filePath)
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description
      ? frontmatter.description
      : null

  return {
    filename: relativePath,
    filePath,
    mtimeMs,
    description,
    type: parseMemoryType(frontmatter.type),
  }
}

function insertNewestHeader(
  headers: RankedMemoryHeader[],
  entry: RankedMemoryHeader,
): void {
  const index = headers.findIndex(
    existing =>
      entry.header.mtimeMs > existing.header.mtimeMs ||
      (entry.header.mtimeMs === existing.header.mtimeMs &&
        entry.order < existing.order),
  )
  if (index === -1) {
    if (headers.length < MAX_MEMORY_FILES) {
      headers.push(entry)
    }
    return
  }

  headers.splice(index, 0, entry)
  if (headers.length > MAX_MEMORY_FILES) {
    headers.length = MAX_MEMORY_FILES
  }
}

export const __test = {
  FRONTMATTER_MAX_BYTES,
  FRONTMATTER_MAX_LINES,
  HEADER_READ_CONCURRENCY,
  scanMemoryFilesWithDependencies,
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
