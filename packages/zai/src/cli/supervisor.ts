import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { writeManagedState, type ManagedState } from './managedState.js'
import { MAX_RESTART_ATTEMPTS, READY_TIMEOUT_MS, nextBackoffMs } from './backoff.js'

export type SupervisorDeps = {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  writeState: (patch: Partial<ManagedState>) => Promise<void>
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
}

type ChildMsg = { type: 'ready'; pid: number; port: number } | { type: 'restarted' } | { type: 'shutdown-ack' }
type RestartReason = 'user_action' | 'auto_recovery' | 'update'

export async function runSupervisor(
  opts: { args: string[]; env: NodeJS.ProcessEnv; port: number },
  depsIn?: Partial<SupervisorDeps>,
): Promise<{ exitCode: number }> {
  const deps: SupervisorDeps = {
    spawn: depsIn?.spawn ?? nodeSpawn,
    writeState: depsIn?.writeState ?? ((p) => writeManagedState(p)),
    log: depsIn?.log ?? ((line) => console.log(line)),
    sleep: depsIn?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }

  await deps.writeState({
    supervisorPid: process.pid,
    state: 'starting',
    childPid: null,
    startedAt: new Date().toISOString(),
    restarts: 0,
    lastError: null,
  })

  let attempts = 0
  let pendingRestart: RestartReason | null = null
  let exitCode: number | null = null

  while (exitCode === null) {
    const child = deps.spawn(process.execPath, opts.args, {
      stdio: ['ipc', 'inherit', 'inherit'],
      detached: false,
      env: { ...opts.env, ZAI_SUPERVISOR_PID: String(process.pid) },
    })

    await deps.writeState({ state: 'starting', childPid: child.pid ?? null })

    const gotReady = await new Promise<boolean>((resolve) => {
      const onMsg = (msg: unknown) => {
        if (msg && typeof msg === 'object' && (msg as ChildMsg).type === 'ready') {
          cleanup()
          resolve(true)
        }
      }
      const onExit = () => { cleanup(); resolve(false) }
      const timer = setTimeout(() => { cleanup(); resolve(false) }, READY_TIMEOUT_MS)
      const cleanup = () => {
        clearTimeout(timer)
        child.off('message', onMsg)
        child.off('exit', onExit)
      }
      child.on('message', onMsg)
      child.once('exit', onExit)
    })

    if (!gotReady) {
      attempts++
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        await deps.writeState({
          state: 'failed',
          lastError: { at: new Date().toISOString(), message: 'ready timeout' },
        })
        exitCode = 1
        break
      }
      await deps.sleep(nextBackoffMs(attempts))
      continue
    }

    attempts = 0
    await deps.writeState({ state: 'running' })

    pendingRestart = null
    const exitPromise = new Promise<{ code: number | null }>((resolve) => {
      let resolved = false
      const tryResolve = (code: number | null) => {
        if (resolved) return
        resolved = true
        resolve({ code: code ?? 0 })
      }
      child.once('exit', (code) => tryResolve(code))
      // race: child may have exited before we attached the listener
      // (e.g. test fires c.emit('exit') synchronously after c.emit('ready'))
      // check exitCode/signalCode which real ChildProcess also exposes
      if (child.exitCode != null || child.signalCode != null) {
        tryResolve(child.exitCode)
      }
    })

    child.on('message', (raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const m = raw as { type?: string; reason?: RestartReason }
        if (m.type === 'restart' && m.reason) {
          pendingRestart = m.reason
          deps.log(`[supervisor] restart requested (${m.reason})`)
        }
      }
    })

    const { code } = await exitPromise

    if (pendingRestart) {
      await deps.writeState({ state: 'restarting' })
      // restart counter is bumped below on next iteration start (T5)
      continue
    }

    // 正常退出
    exitCode = code ?? 0
  }

  return { exitCode }
}
