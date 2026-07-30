import { join } from 'path'
import { CONFIG_DIRNAME, WIKI_DIRNAME } from '../../constants.js'
import type { WikiPaths } from './types.js'

export { WIKI_DIRNAME } from '../../constants.js'

export function getWikiPaths(cwd: string): WikiPaths {
  const root = join(cwd, CONFIG_DIRNAME, WIKI_DIRNAME)

  return {
    root,
    pagesDir: join(root, 'pages'),
    sourcesDir: join(root, 'sources'),
    schemaFile: join(root, 'schema.md'),
    indexFile: join(root, 'index.md'),
    logFile: join(root, 'log.md'),
  }
}
