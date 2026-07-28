import { existsSync } from 'fs'
import { join } from 'path'

const CODEGRAPH_DIR_NAME = '.codegraph'
const CODEGRAPH_DB_NAME = 'codegraph.db'
const CODEGRAPH_DB_PATH = join(CODEGRAPH_DIR_NAME, CODEGRAPH_DB_NAME)

// Looser check — true as soon as the .codegraph scaffold exists, even
// before the indexer has produced a db. Used by the /codegraph command
// to decide whether to surface the command and offer an init prompt.
export function hasCodegraphDir(cwd: string): boolean {
  return existsSync(join(cwd, CODEGRAPH_DIR_NAME))
}

// Strict check — true only when the index db is present. Used by the
// system-prompt section to decide whether to teach the model about
// codegraph tools, and by /codegraph to know the index is queryable.
export function hasCodegraphIndex(cwd: string): boolean {
  return existsSync(join(cwd, CODEGRAPH_DB_PATH))
}
