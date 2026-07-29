import type { CommandSpec } from '../registry.ts'
import alias from './alias.ts'
import nohup from './nohup.ts'
import pyright from './pyright.ts'
import sleep from './sleep.ts'
import srun from './srun.ts'
import time from './time.ts'
import timeout from './timeout.ts'

export default [
  pyright,
  timeout,
  sleep,
  alias,
  nohup,
  time,
  srun,
] satisfies CommandSpec[]
