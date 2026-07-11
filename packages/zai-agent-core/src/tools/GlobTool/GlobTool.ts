import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'path'
import type { LegacyTool, LegacyToolContext as ToolContext } from '../Tool.js'
import { GlobInputSchema, type GlobInput } from './schema.js'
import { renderPrompt } from './prompt.js'

// Node 22+ has fs.promises.glob; @types/node 20 doesn't expose it. Load via createRequire.
const require_ = createRequire(import.meta.url)
const fsPromises = require_('fs/promises') as { glob: (pattern: string, opts: { cwd: string }) => AsyncGenerator<string> }
const glob = fsPromises.glob

const MAX_RESULTS = 100

export const GlobTool: LegacyTool<typeof GlobInputSchema, string> = {
  name: 'Glob',
  description: renderPrompt(),
  inputSchema: GlobInputSchema,
  isReadOnly: () => true,

  async call(rawInput, ctx) {
    const input = rawInput as GlobInput
    const baseDir = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path))
      : ctx.cwd

    let matches: string[] = []
    try {
      for await (const entry of glob(input.pattern, { cwd: baseDir })) {
        matches.push(entry)
        if (matches.length > MAX_RESULTS) break
      }
    } catch (e) {
      return { output: `Glob failed in ${baseDir}: ${(e as Error).message}`, isError: true }
    }

    const truncated = matches.length > MAX_RESULTS
    if (truncated) matches = matches.slice(0, MAX_RESULTS)
    if (matches.length === 0) return { output: `No files matched "${input.pattern}" in ${baseDir}` }
    const header = truncated
      ? `Found ${matches.length}+ matches (showing first ${MAX_RESULTS}):`
      : `Found ${matches.length} matches:`
    return { output: `${header}\n${matches.join('\n')}` }
  },
}
