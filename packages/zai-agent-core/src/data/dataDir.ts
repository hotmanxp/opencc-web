import { homedir } from 'os'
import { join } from 'path'

export type DataDirConfig = {
  resolved: string
  fromEnv: boolean
  fromCli: boolean
}

export function resolveDataDir(opts?: {
  cliOverride?: string
  envOverride?: string
  homedir?: string
}): DataDirConfig {
  const home = opts?.homedir ?? homedir()
  const env = opts?.envOverride ?? process.env.ZAI_DATA_DIR

  let path: string
  let fromEnv = false
  let fromCli = false

  if (opts?.cliOverride !== undefined) {
    path = opts.cliOverride
    fromCli = true
  } else if (env !== undefined) {
    path = env
    fromEnv = true
  } else {
    path = join(home, '.zai')
  }

  return { resolved: path, fromEnv, fromCli }
}
