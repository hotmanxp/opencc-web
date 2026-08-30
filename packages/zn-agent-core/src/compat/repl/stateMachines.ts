// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L2 state machines — REPL.tsx onSubmit /
 * onQuery / onQueryImpl extracted to imperative class form.
 * Each class exposes the same callback shape as the original React handler.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §4.2.
 */

import type { QueuedCommand } from './setup/setupCommandQueue.js'

// ----- OnSubmitStateMachine -----

type OnSubmitOpts = {
  cmdQueue: {
    enqueue(cmd: QueuedCommand): void
    drain(): QueuedCommand[]
    peek(): QueuedCommand[]
    teardown(): void
  }
  onQuery: { submit(input: any): Promise<void> }
}

export class OnSubmitStateMachine {
  constructor(private opts: OnSubmitOpts) {}

  submit(input: string): void {
    const trimmed = input.trim()
    if (!trimmed) return
    const mode = trimmed.startsWith('/') ? 'slash' : 'prompt'
    this.opts.cmdQueue.enqueue({
      value: trimmed,
      mode,
      priority: 'next',
      uuid: crypto.randomUUID(),
      sessionId: '',
    })
  }
}

// ----- OnQueryStateMachine -----

type OnQueryOpts = {
  query: (opts: any) => AsyncIterable<any>
  guard: { state: { tryStart(): number | null; end(gen: number): boolean; isActive(): boolean }; teardown(): void }
}

// zai patch (2026-08-30, plan P3): track an in-flight interruption flag
// so session.interrupt() can break out of an active query loop without
// throwing. start() resets the flag; signalInterrupt(reason) sets it
// (idempotent — repeated signals are fine); isInterrupted() exposes
// the current state. The flag is opt-in: callers that don't consult
// it behave exactly as before. Spec §4.2.
export class OnQueryStateMachine {
  private interrupted = false
  constructor(private opts: OnQueryOpts) {}

  start(opts: any): number | null {
    const gen = this.opts.guard.state.tryStart()
    if (gen === null) return null
    this.interrupted = false
    // Actual query loop runs in OnQueryImplStateMachine
    return gen
  }

  signalInterrupt(reason: string): void {
    this.interrupted = true
  }

  isInterrupted(): boolean {
    return this.interrupted
  }
}

// ----- OnQueryImplStateMachine -----

type OnQueryImplOpts = {
  getSystemPrompt: (tools: any, model: any, dirs: any, mcpClients: any) => Promise<string>
  getUserContext: () => Promise<any>
  getSystemContext: () => Promise<any>
}

type BuiltContext = {
  systemPrompt: string
  userContext: any
  systemContext: any
}

export class OnQueryImplStateMachine {
  constructor(private opts: OnQueryImplOpts) {}

  async buildContext(input: {
    tools: any
    model: any
    additionalWorkingDirectories: any
    mcpClients: any
  }): Promise<BuiltContext> {
    const [systemPrompt, userContext, systemContext] = await Promise.all([
      this.opts.getSystemPrompt(input.tools, input.model, input.additionalWorkingDirectories, input.mcpClients),
      this.opts.getUserContext(),
      this.opts.getSystemContext(),
    ])
    return { systemPrompt, userContext, systemContext }
  }
}
