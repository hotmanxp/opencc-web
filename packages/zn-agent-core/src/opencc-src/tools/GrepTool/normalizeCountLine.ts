import { toRelativePath } from '../../utils/path.js'

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
 * pulling in the full GrepTool module — that module has a transitive import
 * chain that ends in GlobTool/UI.tsx, which references the GrepTool const
 * before it's initialized.
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
  // Unrecognized shape — pass through unchanged. The downstream parser will
  // skip it (lastIndexOf(':') <= 0), so the only impact is the display line.
  return line
}
