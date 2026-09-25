/** Run a child process with inherited stdio so long builds stream live. */
import { spawn } from 'node:child_process'

/**
 * Run a command to completion, streaming its output to this process.
 *
 * `execFile` buffers output until exit, which hides progress on the
 * multi-minute build and packaging steps and makes a slow network fetch look
 * like a hang.
 * @param {string} command - executable to run.
 * @param {string[]} args - arguments.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options] - spawn options.
 * @returns {Promise<void>} resolves on exit code 0, rejects otherwise.
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}
