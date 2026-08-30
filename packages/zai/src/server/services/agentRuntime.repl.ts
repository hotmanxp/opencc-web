// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): ReplRuntime adapter.
 * Wraps createReplSession (zn-agent-core compat/repl) as OpenccRuntimeV2
 * interface. Wires session lifecycle to zai eventBus + translateSdkToRuntime.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.1.
 */

import { createReplSession } from '@zn-ai/zn-agent-core'
import { translateSdkToRuntime } from '@zn-ai/zn-agent-core/compat/runtime/sdkEventAdapter.js'
import { randomUUID } from 'crypto'

export class ReplRuntime {
  private sessions = new Map<string, ReturnType<typeof createReplSession>>()

  async *query(input: any) {
    const session = await this.getOrCreate(input.sessionId)
    await session.submit(input.prompt)
    // P1: route ReplEvent 'notification' through translateSdkToRuntime
    // Adapter registers an onEvent listener and yields converted events.
    // (P1 stub: emits synthetic runtime.delta for testing.)
    yield { type: 'runtime.started', sessionId: input.sessionId, turnIndex: 0 }
    yield { type: 'runtime.done', sessionId: input.sessionId, turnIndex: 0 }
  }

  async abort(sessionId: string, reason?: string) {
    const session = this.sessions.get(sessionId)
    if (session) await session.interrupt(reason)
  }

  async enqueue(input: { sessionId: string; prompt: any; priority: 'now' | 'next' | 'later' }) {
    const session = await this.getOrCreate(input.sessionId)
    await session.enqueue(input.prompt, input.priority)
  }

  async interrupt(sessionId: string, reason?: string) {
    const session = this.sessions.get(sessionId)
    if (session) await session.interrupt(reason)
  }

  async getSessionState(sessionId: string): Promise<Record<string, unknown> | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return session.getState() as unknown as Record<string, unknown>
  }

  async shutdown() {
    const disposes = Array.from(this.sessions.values()).map(s => s.dispose())
    await Promise.all(disposes)
    this.sessions.clear()
  }

  private async getOrCreate(sessionId: string) {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = createReplSession({
        sessionId,
        cwd: process.cwd(),
        input: (async function* () {})(),
        hooks: {
          onEvent: ev => {
            // Forward to zai eventBus
            // P1: minimal; P2 wires full translateSdkToRuntime path
          },
        },
      })
      this.sessions.set(sessionId, session)
    }
    return session
  }
}
