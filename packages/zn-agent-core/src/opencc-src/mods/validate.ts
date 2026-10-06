import { access, constants as fsConstants } from 'node:fs/promises'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

/**
 * Static validation for mod packages (docs/mods-plan.md §3.4 "加载器安全约束").
 *
 * P1 constraints:
 * - entry must be `.js`/`.mjs` and realpath-resolve inside the mod root
 * - single file ≤ 1MB, mod total ≤ 8MB
 * - only relative-path imports (`./`, `../`) — bare specifiers (npm packages,
 *   `node:*`) are rejected. Mods use globals (JSON/setTimeout/fetch/...) and
 *   the injected ctx; there is deliberately NO module-specified filesystem
 *   access via imports (R7 — capability surface matches upstream).
 *
 * The import scan is a regex pass, not an AST walk (P1 keeps zero new
 * dependencies). Computed specifiers can evade it — this is defense against
 * accidental dependency, not a security boundary (R8: same-process model).
 */

export const MOD_MAX_FILE_BYTES = 1_000_000 // 1MB per file (upstream parity)
export const MOD_MAX_TOTAL_BYTES = 8_000_000 // 8MB per mod (upstream parity)
export const MOD_MAX_FILES = 2000 // walk bound (upstream-style throttle parity)

const ENTRY_EXTENSIONS = new Set(['.js', '.mjs'])
const SCANNABLE_EXTENSIONS = new Set(['.js', '.mjs'])
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

export class ModValidationError extends Error {
  constructor(
    message: string,
    readonly modName: string,
  ) {
    super(message)
    this.name = 'ModValidationError'
  }
}

/** Entry must exist, be .js/.mjs, and realpath inside the mod root. */
export async function validateEntryPath(
  modName: string,
  modRoot: string,
  entryRel: string,
): Promise<string> {
  if (!ENTRY_EXTENSIONS.has(extname(entryRel))) {
    throw new ModValidationError(
      `entry must be a .js or .mjs file, got "${entryRel}"`,
      modName,
    )
  }
  const entryAbs = resolve(modRoot, entryRel)
  // realpath fence: symlinked entry escaping the mod root is rejected
  // (upstream h2e() parity: realpath + relative() + startsWith('..')).
  let entryReal: string
  try {
    entryReal = await realpath(entryAbs)
  } catch {
    throw new ModValidationError(`entry not found: "${entryRel}"`, modName)
  }
  let rootReal: string
  try {
    rootReal = await realpath(modRoot)
  } catch {
    throw new ModValidationError(
      `mod root is not a readable directory`,
      modName,
    )
  }
  const rel = relative(rootReal, entryReal)
  if (rel.startsWith('..') || rel === '') {
    throw new ModValidationError(
      `entry resolves outside the mod folder: "${entryRel}"`,
      modName,
    )
  }
  return entryReal
}

/** Collect scannable files inside the mod root (fence-checked, bounded). */
async function listModFiles(
  modName: string,
  modRoot: string,
): Promise<string[]> {
  const rootReal = await realpath(modRoot)
  const files: string[] = []
  let count = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 16 || count >= MOD_MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= MOD_MAX_FILES) return
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // Reject symlinks whose target escapes the mod root
      const st = await lstat(abs)
      if (st.isSymbolicLink()) {
        let target: string | undefined
        try {
          target = await realpath(abs)
        } catch {
          continue // dangling symlink — ignore
        }
        if (target && relative(rootReal, target).startsWith('..')) {
          throw new ModValidationError(
            `symlink escapes the mod folder: ${relative(rootReal, abs)}`,
            modName,
          )
        }
      }
      count++
      if (SCANNABLE_EXTENSIONS.has(extname(entry.name))) {
        files.push(abs)
      }
    }
  }
  await walk(rootReal, 0)
  return files
}

/** Size caps: single file ≤ 1MB, total ≤ 8MB. */
export async function validateModSize(
  modName: string,
  modRoot: string,
): Promise<void> {
  const files = await listModFiles(modName, modRoot)
  let total = 0
  for (const file of files) {
    const st = await stat(file)
    if (st.size > MOD_MAX_FILE_BYTES) {
      throw new ModValidationError(
        `file exceeds 1MB limit: ${relative(modRoot, file)}`,
        modName,
      )
    }
    total += st.size
    if (total > MOD_MAX_TOTAL_BYTES) {
      throw new ModValidationError('mod exceeds 8MB total size limit', modName)
    }
  }
}

// Matches static/dynamic import sources and re-exports. Computed specifiers
// (variables) are not caught — accepted residual risk, see file header.
const IMPORT_SPECIFIER_PATTERNS = [
  /\bimport\s+[^;'"]*?\s+from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+[^;'"]*?\s+from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Reject bare specifiers: only relative imports (`./`, `../`) are allowed. */
export async function validateModImports(
  modName: string,
  modRoot: string,
): Promise<void> {
  const files = await listModFiles(modName, modRoot)
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pattern.exec(source)) !== null) {
        const specifier = m[1]
        if (specifier && !specifier.startsWith('.')) {
          throw new ModValidationError(
            `bare module specifier "${specifier}" is not allowed in mods (only relative ./ or ../ imports) — file ${relative(modRoot, file)}`,
            modName,
          )
        }
      }
    }
  }
}

/** Check the mod root is a readable directory (early, clear error). */
export async function validateModRootReadable(
  modName: string,
  modRoot: string,
): Promise<void> {
  try {
    const st = await stat(modRoot)
    if (!st.isDirectory()) {
      throw new ModValidationError('mod root is not a directory', modName)
    }
  } catch (error) {
    if (error instanceof ModValidationError) throw error
    throw new ModValidationError(
      `mod root is not readable: ${error instanceof Error ? error.message : String(error)}`,
      modName,
    )
  }
  await access(modRoot, fsConstants.R_OK)
}
