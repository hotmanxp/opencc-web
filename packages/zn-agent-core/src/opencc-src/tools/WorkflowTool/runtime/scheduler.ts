export type SchedulerOpts = {
  maxConcurrent: number
  maxTotal: number
}

type QueuedTask = {
  fn: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

/**
 * Concurrency-limiting queue.
 * - maxConcurrent: maximum tasks running at the same time
 * - maxTotal: maximum tasks that can be enqueued total (across the queue + running)
 *
 * Total count is incremented at `run()` time, BEFORE the task is queued. This means
 * a task that's been `run()`-called but is waiting in the queue counts toward maxTotal.
 * This is intentional — we want to bound the total work, not just concurrency.
 */
export class Scheduler {
  private queue: QueuedTask[] = []
  private _running = 0
  private _total = 0

  constructor(private readonly opts: SchedulerOpts) {
    if (opts.maxConcurrent < 1) {
      throw new Error('Scheduler: maxConcurrent must be >= 1')
    }
    if (opts.maxTotal < 1) {
      throw new Error('Scheduler: maxTotal must be >= 1')
    }
  }

  get running(): number {
    return this._running
  }

  get total(): number {
    return this._total
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this._total >= this.opts.maxTotal) {
      throw new Error(
        `Max ${this.opts.maxTotal} agents per workflow run (already spawned ${this._total})`,
      )
    }
    this._total++

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: (v) => resolve(v as T),
        reject,
      })
      this.drain()
    })
  }

  private drain(): void {
    while (this._running < this.opts.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) break
      this._running++
      // Promise.resolve().then() ensures sync throws from task.fn() are caught
      // and routed through the rejection path — otherwise _running would leak.
      Promise.resolve()
        .then(() => task.fn())
        .then(task.resolve, task.reject)
        .finally(() => {
          this._running--
          this.drain()
        })
    }
  }
}
