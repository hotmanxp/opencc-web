import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { writeManagedState, type ManagedState } from './managedState.js'
import { MAX_RESTART_ATTEMPTS, READY_TIMEOUT_MS, nextBackoffMs } from './backoff.js'
import { appendRestartLog } from './restartLog.js'

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

  let attempts = 0
  let pendingRestart: RestartReason | null = null
  let exitCode: number | null = null
  let restarts = 0
  let currentChild: ChildProcess | null = null
  let lastChildStartTs = 0
  let lastChildPid: number | null = null
  let userShutdown = false
  let sigkillTimer: NodeJS.Timeout | null = null
  const onSigint = () => {
    userShutdown = true
    if (currentChild) currentChild.kill('SIGINT')
    if (sigkillTimer) clearTimeout(sigkillTimer)
    sigkillTimer = setTimeout(() => { if (currentChild) currentChild.kill('SIGKILL') }, 10_000)
  }
  process.on('SIGINT', onSigint)

  await deps.writeState({
    supervisorPid: process.pid,
    state: 'starting',
    childPid: null,
    startedAt: new Date().toISOString(),
    restarts,
    lastError: null,
  })

  while (exitCode === null) {
    if (pendingRestart) {
      // bump counter on entry of the restart iteration
      restarts++
      await deps.writeState({ restarts })
      const reason = pendingRestart
      pendingRestart = null
      // log restart_executed for the previous child (from spawn to restart msg)
      if (lastChildStartTs > 0) {
        appendRestartLog({
          type: 'restart_executed',
          childPid: lastChildPid,
          durationMs: Date.now() - lastChildStartTs,
          ...(reason ? { reason } : {}),
        }).catch(() => {})
      }
    }
    const child = deps.spawn(process.execPath, opts.args, {
      stdio: ['ipc', 'inherit', 'inherit'],
      detached: false,
      env: { ...opts.env, ZAI_SUPERVISOR_PID: String(process.pid) },
    })
    currentChild = child
    lastChildStartTs = Date.now()
    lastChildPid = child.pid ?? null

    await deps.writeState({ state: 'starting', childPid: child.pid ?? null })

    // Forward child IPC messages to the supervisor's own parent so
    // wrappers (zai start, integration tests) can observe the lifecycle.
    // Only register when an IPC parent actually exists; in test/CI envs
    // process.send is undefined, and adding a listener would interfere
    // with the FakeChild's emit-time buffering seam used by unit tests.
    if (typeof process.send === 'function') {
      const parentSend = process.send
      child.on('message', (raw: unknown) => {
        try {
          parentSend(raw)
        } catch {
          // parent IPC closed — ignore, child is still being managed
        }
      })
    }

    // Forward `restart` requests from the supervisor's own parent down to
    // the child. Production supervisors have no parent IPC, so this is a
    // no-op in normal operation. Integration tests use this path to
    // exercise the restart cycle end-to-end.
    const onParentMsg = (raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const m = raw as { type?: string; reason?: RestartReason }
        if (m.type === 'restart' && m.reason) {
          pendingRestart = m.reason
          try {
            child.send(raw)
          } catch {
            // child IPC closed — ignore, exit handler will resolve soon
          }
        }
      }
    }
    process.on('message', onParentMsg)

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
      if (userShutdown) {
        exitCode = 128 + 2
        break
      }
      appendRestartLog({
        type: 'ready_timeout',
        childPid: child.pid ?? null,
      }).catch(() => {})
      attempts++
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        await deps.writeState({
          state: 'failed',
          lastError: { at: new Date().toISOString(), message: 'ready timeout' },
        })
        appendRestartLog({
          type: 'failed',
          childPid: child.pid ?? null,
          durationMs: lastChildStartTs > 0 ? Date.now() - lastChildStartTs : undefined,
          reason: 'ready_timeout',
        }).catch(() => {})
        exitCode = 1
        break
      }
      await deps.sleep(nextBackoffMs(attempts))
      continue
    }

    attempts = 0
    await deps.writeState({ state: 'running' })

    // NOTE: do not clear pendingRestart here. A restart request forwarded by
    // onParentMsg (integration tests drive the cycle via parent IPC) can land
    // while this await chain is still unwinding — clearing it would drop the
    // request and the supervisor would exit instead of respawning. The while
    // loop head already nulls it after each restart iteration.
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
          // best-effort log; failures must not block the restart cycle
          appendRestartLog({
            type: 'restart_requested',
            childPid: child.pid ?? null,
            reason: m.reason,
          }).catch(() => {})
        }
      }
    })

    const { code } = await exitPromise
    currentChild = null

    if (pendingRestart) {
      await deps.writeState({ state: 'restarting' })
      // restart counter is bumped below on next iteration start (T5)
      continue
    }

    if (userShutdown) {
      exitCode = 128 + 2
      break
    }

    // 正常退出
    exitCode = code ?? 0
  }

  return { exitCode }
}

// Allow `bun run src/cli/supervisor.ts --child-script <path>` to spawn a child
// for integration tests. Production callers (start.ts) keep importing
// runSupervisor directly and ignore this block.
if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2)
  const port = Number(process.env.ZAI_PORT ?? '9201')
  runSupervisor({ args, env: process.env, port }).then(({ exitCode }) => {
    process.exit(exitCode)
  })
}
