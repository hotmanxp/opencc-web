// @ts-nocheck
/**
 * 处理 stdout/stderr 上的 EPIPE 错误.
 *
 * 当上游管道 (例如 `zai | head -1`、容器被关闭或 UI 控制台断连等) 关闭时,
 * Node 的 stdout/stderr Socket 会触发 'error' 事件, code='EPIPE'.
 * 这是预期行为, 不应让 zai 进程因为一个未处理的 stream error 整段 crash.
 *
 * 注册 handler 后:
 * - 当 EPIPE 抛上来时调用 stream.destroy(), 让 Node 把该 socket 关掉
 *   并阻止 NodeEventLoop 因为 unhandled 'error' event 杀掉进程
 * - process.on('uncaughtException') 兜底: 任何路径冒上来的 EPIPE
 *   也静默吃掉, 避免 zai 在 detached TTY / supervisor 重启管道
 *   场景下意外退出
 */
const EPIPE_HANDLERS = new WeakMap<NodeJS.WriteStream, (err: NodeJS.ErrnoException) => void>()
const UNCAUGHT_REGISTERED = { installed: false }
const ORIGINAL_UNCAUGHT: { current: NodeJS.UncaughtExceptionListener[] } = {
  current: [],
}

function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err && err.code === 'EPIPE') {
      // 让 Node 把该 socket 关掉, 否则下次 write 还是 EPIPE
      try {
        stream.destroy()
      } catch {
        // 已经被关过或不可写, 吞掉
      }
    }
  }
}

function ensureUncaughtFallback(): void {
  if (UNCAUGHT_REGISTERED.installed) return
  UNCAUGHT_REGISTERED.installed = true
  const listener: NodeJS.UncaughtExceptionListener = ((err: NodeJS.ErrnoException) => {
    if (err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
      // EPIPE 静默丢弃 — 见文件头注释
      return
    }
    // 其它 uncaughtException 仍然向上抛, 不掩盖其它真实问题
    throw err
  }) as NodeJS.UncaughtExceptionListener
  ORIGINAL_UNCAUGHT.current = [...ORIGINAL_UNCAUGHT.current, listener]
  process.on('uncaughtException', listener)
}

/**
 * 在 process.stdout / process.stderr 上注册 EPIPE handler.
 * 幂等 — 重复调用不会重复绑定同一份 listener.
 */
export function registerProcessOutputErrorHandlers(): void {
  ensureUncaughtFallback()
  for (const stream of [process.stdout, process.stderr] as NodeJS.WriteStream[]) {
    if (EPIPE_HANDLERS.has(stream)) continue
    const h = handleEPIPE(stream)
    EPIPE_HANDLERS.set(stream, h)
    stream.on('error', h)
  }
}

/**
 * Test seam: 清掉已注册的 listeners. 防止多个 test 重复堆叠.
 */
export function __resetProcessOutputErrorHandlersForTests(): void {
  for (const stream of [process.stdout, process.stderr] as NodeJS.WriteStream[]) {
    const h = EPIPE_HANDLERS.get(stream)
    if (h) {
      stream.off('error', h)
      EPIPE_HANDLERS.delete(stream)
    }
  }
  for (const listener of ORIGINAL_UNCAUGHT.current) {
    process.off('uncaughtException', listener)
  }
  ORIGINAL_UNCAUGHT.current = []
  UNCAUGHT_REGISTERED.installed = false
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  // Note: we don't handle backpressure (write() returning false).
  //
  // We should consider handling the callback to ensure we wait for data to flush.
  try {
    stream.write(data /* callback to handle here */)
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
      stream.destroy()
      return
    }
    throw err
  }
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
}

// Write error to stderr and exit with code 1. Consolidates the
// console.error + process.exit(1) pattern used in entrypoint fast-paths.
export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// Wait for a stdin-like stream to close, but give up after ms if no data ever
// arrives. First data chunk cancels the timeout — after that, wait for end
// unconditionally (caller's accumulator needs all chunks, not just the first).
// Returns true on timeout, false on end. Used in -p mode to distinguish a
// real pipe producer from an inherited-but-idle parent stdin.
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
