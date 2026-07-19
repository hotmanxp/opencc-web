import { isAbsolute, relative } from 'path'
import { cwd } from 'process'

/**
 * Convert an absolute path to one relative to cwd if it lives under cwd.
 * Otherwise return the absolute path unchanged. Inline copy of opencc's
 * `toRelativePath` so normalizeCountLine can run in test environments where
 * `opencc-internals/utils/path.ts` has unresolved transitive imports.
 */
function toRelativePath(absolutePath: string): string {
  if (!isAbsolute(absolutePath)) return absolutePath
  const base = cwd()
  const rel = relative(base, absolutePath)
  // On Windows + drive-letter mismatch relative() returns an absolute path.
  // Treat that as "not under cwd" and pass through.
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel
  }
  return absolutePath
}

/**
 * Normalize a single line of `rg -c` output into uniform "relpath:count" form.
 *
 * ripgrep omits the filename when the search has a single input file, so the
 * line is just a bare number like "3" instead of "/abs/path:3". We reattach
 * the searched file's path so the downstream parser and display stay uniform
 * across single-file and multi-file searches.
 * Ref: https://github.com/BurntSushi/ripgrep/blob/master/FAQ.md#why-doesnt-ripgrep-show-the-filename-when-using---count
 *
 * Lives in its own file (not GrepTool.ts) so the test can import it without
 * pulling in the full GrepTool module — that module imports `node:child_process`
 * which the vitest mock setup needs to register before GrepTool loads.
 */
export function normalizeCountLine(
  line: string,
  fallbackAbsolutePath: string,
): string {
  const colonIndex = line.lastIndexOf(':')
  if (colonIndex > 0) {
    const filePath = line.substring(0, colonIndex)
    const count = line.substring(colonIndex)
    return toRelativePath(filePath) + count
  }
  // Bare number from a single-file search — reattribute to the searched file.
  if (/^\d+$/.test(line)) {
    return `${toRelativePath(fallbackAbsolutePath)}:${line}`
  }
  // Unrecognized shape — pass through unchanged.
  return line
}
